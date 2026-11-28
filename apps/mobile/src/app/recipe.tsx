// The recipe sheet. It slides up as soon as a photo is sent, shows "Finding your recipe…", then the closest match
// with a CREME-style cover photo from the shared library, the other matches to switch between, diet versions and Save.
import Ionicons from "@expo/vector-icons/Ionicons";
import { LinearGradient } from "expo-linear-gradient";
import { router, useFocusEffect } from "expo-router";
import * as Sharing from "expo-sharing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type CurrentRecipe, useApp } from "../AppContext";
import { ApiError } from "../api/client";
import { useCamera } from "../camera/CameraProvider";
import { diets_for_kind, or_list } from "../onboarding/onboarding";
import { useOnboarding } from "../onboarding/OnboardingProvider";
import { FREE_SAVED_RECIPES } from "../paywall/plans";
import { bundled_photo_uri, bundled_recipe, bundled_version, find_bundled_dish } from "../recipes/bundled";
import { possible_allergen_line } from "../recipes/allergenRisk";
import { COLLECTION } from "../recipes/collectionPhotos";
import { bundled_diet_profile } from "../recipes/dietProfile";
import { diet_profile } from "../recipes/diets";
import { format_ingredient, format_minutes, recipe_as_text } from "../recipes/format";
import { scale_amount } from "../recipes/scale";
import { ReportRecipe } from "../recipes/ReportRecipe";
import { curated_version } from "../recipes/curatedVersions";
import { record_viewed } from "../recipes/recentItems";
import { ADDITION_HINTS, type Addition, additions_for, is_premium_diet } from "../recipes/premiumVersions";
import { RateRecipe } from "../recipes/RateRecipe";
import { DIETS, type Diet, type Guess, type Kind, NO_IMAGE, type Recipe } from "../recipes/types";
import { useDishImage } from "../recipes/useDishImage";
import { usePreferences } from "../settings/PreferencesProvider";
import { SavedLimitError } from "../saved/savedRecipes";
import { STORE_URL } from "../settings/legalLinks";
import { useTips } from "../tips/TipsProvider";
import { FocusedCover } from "../ui/FocusedCover";
import { TipBubble } from "../ui/TipBubble";
import { Button, Chip, fonts, Notice, useTheme, useThemedStyles, type Palette } from "../ui/theme";
import { useStoreReviewPrompt } from "../review/useStoreReviewPrompt";

const heroArt = require("../../assets/hero.png");
type Ready = Extract<CurrentRecipe, { status: "ready" }>;

export default function RecipeScreen() {
  const { current, recipe_requests } = useApp();
  useFocusEffect(useCallback(() => () => recipe_requests.invalidate(), [recipe_requests]));
  const previous = current?.status === "ai-offer" && current.previous?.status === "ready" ? current.previous : null;
  const ready = current?.status === "ready" ? current : previous;
  return (
    <>
      {ready && (
        <View
          style={previous ? { display: "none" } : { flex: 1 }}
          accessibilityElementsHidden={!!previous}
          importantForAccessibility={previous ? "no-hide-descendants" : "auto"}
        >
          <RecipeView current={ready} />
        </View>
      )}
      {current?.status === "ai-offer" && (
        // A new set of names (a typed correction) is a new question, so nothing chosen for the last one carries over.
        <AiOffer key={`${current.kind}|${current.guesses.map((g) => g.name).join("|")}`} current={current} />
      )}
      {current?.status === "problem" && <Problem message={current.message} source={current.source ?? "photo"} />}
      {(!current || current.status === "loading") && <Finding photo={current?.status === "loading" ? current.photo : undefined} />}
    </>
  );
}

/**
 * A photo of a dish Recipeak doesn't have. Nothing more is made unless the person says yes: then the server writes a
 * recipe, checks it a second time, makes its photo, and keeps both, so the next person gets them straight away.
 */
function AiOffer({ current }: { current: Extract<CurrentRecipe, { status: "ai-offer" }> }) {
  const { api, set_current, recipe_requests } = useApp();
  const { photosLeft, refresh_allowance } = useCamera();
  const { type } = useTheme();
  const styles = useThemedStyles(create_styles);
  const [busy, set_busy] = useState(false);
  // Set at once (state waits for the next render), so a second tap can never send a second request.
  const making = useRef(false);
  const [problem, set_problem] = useState<string | null>(null);
  // The other guesses: ones Recipeak has open their own recipe; the rest can be chosen for the AI recipe instead.
  const in_library = current.guesses.map((g) => find_bundled_dish(current.kind, g.name));
  const unknown = current.guesses.map((_, i) => i).filter((i) => !in_library[i]);
  const [target, set_target] = useState(unknown[0] ?? 0);
  const name = current.guesses[target].name;
  const what = current.kind === "cocktail" ? "drink" : "meal";

  async function make() {
    if (making.current) return;
    making.current = true;
    set_busy(true);
    set_problem(null);
    const active = recipe_requests.begin();
    try {
      const made = await api.recipe(name, current.kind, undefined, { correction: Boolean(current.correction) });
      if (!active()) return;
      if (current.correction) refresh_allowance();
      set_current({
        status: "ready",
        kind: current.kind,
        recipe: made.recipe,
        guesses: current.guesses,
        selected: target,
        image: made.image,
        localPhoto: null,
        savedId: null,
        ai: true,
      });
    } catch (error) {
      if (!active()) return;
      if (error instanceof ApiError && error.needsUpgrade) {
        router.push({ pathname: "/upgrade", params: { reason: error.upgradeReason } });
      } else {
        set_problem(error instanceof ApiError ? error.message : "Couldn't make that recipe. Please try again.");
      }
    } finally {
      making.current = false;
      set_busy(false);
      if (active() && current.correction) refresh_allowance();
    }
  }

  async function open_library(index: number) {
    const dish = in_library[index];
    const recipe = dish && bundled_recipe(dish);
    if (!dish || !recipe || busy) return;
    const active = recipe_requests.begin();
    const localPhoto = await bundled_photo_uri(dish);
    if (!active()) return;
    set_current({
      status: "ready",
      kind: current.kind,
      recipe,
      guesses: current.guesses,
      selected: index,
      image: NO_IMAGE,
      localPhoto,
      savedId: null,
      bundledId: dish.id,
    });
  }

  // No request is sent and nothing is used: back to the recipe or screen the name was typed on, or closed.
  function not_now() {
    if (current.previous) return set_current(current.previous);
    set_current(null);
    router.back();
  }

  return (
    <Sheet>
      {/* "handled": with the keyboard up for the name box, a tap on a button works first time (see RecipeView). */}
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.body, { paddingTop: 90, paddingBottom: 40, gap: 14 }]}>
        <Text style={type.title} accessibilityRole="header">
          {`We don't have this ${what} yet`}
        </Text>
        <Text style={type.body}>
          {current.typed
            ? `Relish doesn't have a recipe for ${current.guesses[0].name} yet.`
            : `It looks like ${current.guesses[0].name}, but Relish doesn't have a recipe for it.`}
        </Text>
        {in_library.some(Boolean) && (
          <>
            <Text style={type.body}>Could it be one of these? Relish has them:</Text>
            {in_library.map((dish, i) =>
              dish ? (
                <Button
                  key={dish.id}
                  label={`Open ${dish.name}`}
                  variant="secondary"
                  disabled={busy}
                  onPress={() => void open_library(i)}
                />
              ) : null,
            )}
          </>
        )}
        {unknown.length > 1 && (
          <>
            <Text style={type.body}>Which one should Relish make?</Text>
            <View style={styles.wrap}>
              {unknown.map((i) => (
                <Chip key={i} label={current.guesses[i].name} selected={i === target} onPress={() => set_target(i)} />
              ))}
            </View>
          </>
        )}
        {unknown.length > 0 && (
          <>
            <Text style={type.body}>{`Would you like Relish to make a recipe and a photo for ${name} with AI?`}</Text>
            <Text style={type.muted}>
              {`Relish will write the recipe, check it a second time, and make a photo of the ${what}. It can take up to a minute. ${ai_allowance_text(photosLeft, Boolean(current.correction))}`}
            </Text>
            <Notice>
              AI recipes are our best effort, checked twice before you see them. Still, check every ingredient and allergen before you cook
              or serve it, especially for anyone with a food allergy.
            </Notice>
            {problem && <Notice tone="error">{problem}</Notice>}
            <Button label="Make AI recipe and photo" busy={busy} onPress={() => void make()} />
          </>
        )}
        <Button label="Not now" variant="secondary" disabled={busy} onPress={not_now} />
        {/* Still in place of an unreadable photo, when that's what this question came from. */}
        <ManualCorrection initialKind={current.kind} correction={current.correction === true} />
      </ScrollView>
    </Sheet>
  );
}

/** What making an AI recipe uses, said before anything starts. photosLeft is null for subscribers. */
export function ai_allowance_text(photosLeft: number | null | undefined, correction: boolean): string {
  if (photosLeft === null) return "It's included with Premium.";
  if (correction)
    return typeof photosLeft === "number" ? `It uses 1 of your free photos (${photosLeft} left).` : "It uses 1 of your free photos.";
  return "It counts as one of the extra recipes that come with each photo.";
}

function Sheet({
  children,
  footer,
  on_share,
  share_tip,
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Shows a share button at the top right, beside the close button. */
  on_share?: () => void;
  /** The one-time "you can share this" tip, shown under the share button after a first save. */
  share_tip?: React.ReactNode;
}) {
  const { recipe_requests } = useApp();
  const styles = useThemedStyles(create_styles);
  const insets = useSafeAreaInsets();
  // On Android the recipe fills the screen, so a solid band keeps scrolled text out from under the clock and icons.
  // On iOS it's a sheet below the status bar and needs no band.
  const status_space = Platform.OS === "android" ? insets.top : 0;
  return (
    <View style={styles.screen}>
      <View
        style={[styles.handle, { top: 8 + status_space }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      {children}
      {footer}
      {status_space > 0 && <View style={[styles.statusBand, { height: status_space }]} pointerEvents="none" />}
      <View style={[styles.topBar, { top: 18 + status_space }]} pointerEvents="box-none">
        <RoundButton
          icon="chevron-down"
          label="Close recipe"
          onPress={() => {
            recipe_requests.invalidate();
            router.back();
          }}
        />
        {on_share && <RoundButton icon="share-outline" label="Share recipe" onPress={on_share} />}
      </View>
      {share_tip && (
        <View style={[styles.shareTip, { top: 18 + status_space + 52 }]} pointerEvents="box-none">
          {share_tip}
        </View>
      )}
      <View style={{ height: insets.bottom }} />
    </View>
  );
}

/** Shown while a recipe loads: the tapped dish's photo when there is one, otherwise the app's art. */
function Finding({ photo }: { photo?: number }) {
  const { colors, type } = useTheme();
  const styles = useThemedStyles(create_styles);
  const { height } = useWindowDimensions();
  return (
    <Sheet>
      <View style={[styles.cover, styles.placeholder, { height: Math.min(Math.round(height * 0.42), 400) }]}>
        {photo ? (
          <Image source={photo} style={StyleSheet.absoluteFill} resizeMode="cover" accessible={false} />
        ) : (
          <Image source={heroArt} style={styles.placeholderArt} resizeMode="contain" accessible={false} />
        )}
      </View>
      <View style={styles.body} accessibilityLiveRegion="polite">
        <View style={styles.findingRow}>
          <ActivityIndicator color={colors.accentInk} />
          <Text style={type.body}>Finding your recipe…</Text>
        </View>
        <View style={[styles.skeleton, { width: "70%", height: 28 }]} />
        <View style={[styles.skeleton, { width: "100%" }]} />
        <View style={[styles.skeleton, { width: "85%" }]} />
      </View>
    </Sheet>
  );
}

/** A recipe that couldn't be shown. After a photo it offers a retake or a typed name; after a Home wall tap, just Close. */
function Problem({ message, source }: { message: string; source: "photo" | "wall" }) {
  const { type } = useTheme();
  const styles = useThemedStyles(create_styles);
  const { open_camera } = useCamera();
  return (
    <Sheet>
      <View style={[styles.body, { paddingTop: 90 }]}>
        <Text style={type.title} accessibilityRole="header">
          {source === "wall" ? "Couldn't open that recipe" : "Let's try that again"}
        </Text>
        <Notice tone="error">{message}</Notice>
        {source === "photo" && (
          <>
            <Button
              label="Retake photo"
              onPress={() => {
                router.back();
                open_camera();
              }}
            />
            <ManualCorrection initialKind="meal" correction />
          </>
        )}
        <Button label="Close" variant="secondary" onPress={() => router.back()} />
      </View>
    </Sheet>
  );
}

function RecipeView({ current }: { current: Ready }) {
  const { colors, type } = useTheme();
  const styles = useThemedStyles(create_styles);
  const { set_current, api, saved, ratings, recipe_requests } = useApp();
  const preferences = usePreferences();
  const saving = useRef(false);
  const version_pending = useRef(false);
  const { photosLeft } = useCamera();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { recipe, kind, guesses, selected } = current;
  const maybeAllergens = possible_allergen_line(recipe);
  const dishName = guesses[selected]?.name ?? recipe.title;
  const [diet, set_diet] = useState<Diet | null>(current.diet ?? null);
  const [busy, set_busy] = useState(false);
  const [problem, set_problem] = useState<string | null>(null);
  // Save problems show beside the Save button, not at the top of the page, so they're seen and announced.
  const [save_problem, set_save_problem] = useState<string | null>(null);
  const [just_saved, set_just_saved] = useState(false);
  const tips = useTips();
  // Shares the version on screen: its serving size, its diet version, the person's own note and, for a recipe from
  // their own photo, that photo. Android can't send text and a photo together, so it asks which one.
  const share_recipe = async () => {
    tips.mark_seen("share");
    const rating = await ratings?.get(kind, dishName).catch(() => null);
    const message = recipe_as_text(recipe, { servings, diet, note: rating?.note, store_url: STORE_URL });
    const photo = current.localPhoto;
    const share_text = () => void Share.share({ message }).catch(() => undefined);
    if (!photo) return share_text();
    if (Platform.OS === "ios") return void Share.share({ message, url: photo }).catch(() => undefined);
    Alert.alert("Share", "What would you like to share?", [
      { text: "The recipe", onPress: share_text },
      {
        text: "Your photo",
        onPress: () => void Sharing.shareAsync(photo, { mimeType: "image/jpeg", dialogTitle: recipe.title }).catch(() => undefined),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };
  const [notice, set_notice] = useState<string | null>(
    current.diet ? `Showing the ${current.diet} version, from your diet in Settings.` : null,
  );
  const [servings, set_servings] = useState(recipe.servings || 1);
  const [shownRecipe, set_shown_recipe] = useState(recipe);
  // "Make it non-vegetarian / non-vegan": which one is showing, and the recipe it was made from, so tapping it again
  // goes straight back without asking the server.
  const [addition, set_addition] = useState<Addition | null>(null);
  const [original, set_original] = useState<Recipe | null>(null);
  const [original_ai, set_original_ai] = useState<boolean | undefined>(undefined);
  const base = addition && original ? original : recipe;
  // The standard recipe that was on screen before a diet version, so switching back never asks the server again.
  const [standard, set_standard] = useState<{ recipe: Recipe; ai?: boolean } | null>(null);

  // A new version (another match or a diet) starts at its own serving size.
  if (recipe !== shownRecipe) {
    set_shown_recipe(recipe);
    set_servings(recipe.servings || 1);
  }
  // Another dish (a typed correction or another match) starts with its own versions: nothing chosen or remembered
  // for the last dish carries over to it. The name comes from the match, or (a recipe opened from Saved has none) from
  // the standard recipe, never from the version on screen, whose title changes ("Gimlet (non-alcoholic)").
  const stable_name = guesses[selected]?.name ?? (standard?.recipe ?? base).title;
  const dish_identity = `${kind}|${stable_name}|${current.bundledId ?? ""}`;
  const [shown_dish, set_shown_dish] = useState(dish_identity);
  if (dish_identity !== shown_dish) {
    set_shown_dish(dish_identity);
    set_standard(null);
    set_addition(null);
    set_original(null);
    set_diet(current.diet ?? null);
  }

  // Every recipe opened here (bundled or made with AI) goes into this account's Recently viewed, as its standard recipe.
  const { recent } = useApp();
  // A bundled dish is kept by its id, whatever version shows; a recipe made with AI only as its standard recipe.
  const record = Boolean(current.bundledId) || (diet === null && !addition);
  // "Saved" shows for a recipe already in Saved however it was opened (Explore, Recently viewed, or switching back from
  // a version), with its kept cover when the screen has none, so saving it again never replaces that cover.
  useEffect(() => {
    if (current.savedId) return;
    let live = true;
    const active = recipe_requests.capture();
    saved
      .list()
      .then((list) => {
        const match = list.find((s) => s.kind === kind && s.recipe.title === recipe.title);
        if (live && active() && match)
          set_current({ ...current, savedId: match.id, localPhoto: current.localPhoto ?? match.photo_uri ?? null });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [saved, current, kind, recipe.title, set_current, recipe_requests]);

  const cover = useDishImage(api, kind, dishName, current.image, { lookUp: !current.localPhoto && current.image.status === "unavailable" });
  const coverUri = current.localPhoto ?? cover.uri;
  // A saved recipe whose kept photo went missing gets its library photo back in Saved once it's found here.
  useEffect(() => {
    if (current.savedId && cover.path && !current.localPhoto) void saved.restore_cover(current.savedId, cover.path).catch(() => {});
  }, [saved, current.savedId, current.localPhoto, cover.path]);
  // Recorded again once a photo that was still being made is ready, so Home shows it too.
  useEffect(() => {
    if (record) record_viewed(recent, current, dishName, cover.path);
  }, [recent, current, dishName, record, cover.path]);
  const factor = servings / (recipe.servings || 1);
  const coverHeight = Math.min(Math.round(height * 0.42), 400);

  // The diets chosen in the first-launch tour (or later in Settings). Bundled dishes open in their vegetarian or vegan
  // version on their own (see useOpenWallDish); other diets come from the server and wait for a tap.
  const myDiets = diets_for_kind(useOnboarding().values.diets, kind);
  // Only diets that need a real change are offered; diets the recipe already meets are shown as labels instead.
  const profile = useMemo(() => {
    const dish = current.bundledId ? COLLECTION.find((d) => d.id === current.bundledId) : undefined;
    const regular = dish && bundled_recipe(dish);
    return diet === null && dish && regular ? bundled_diet_profile(dish.id, regular, kind) : diet_profile(base, kind);
  }, [current.bundledId, kind, diet, base]);
  // Only from the standard recipe: a vegetarian version of a meat dish doesn't get "Make it non-vegetarian".
  const additions = diet === null ? additions_for(profile, kind) : [];
  const tapHint = myDiets.filter((d) => d !== diet && (profile.options.includes(d) || profile.status[d]?.status === "review"));
  const dietUnverified = diet !== null && !profile.fits.includes(diet);

  async function load_version(index: number, nextDiet: Diet | null) {
    if (busy || version_pending.current) return;
    version_pending.current = true;
    set_busy(true);
    try {
      const active = recipe_requests.begin();
      const guess = guesses[index];
      const same = index === selected;
      set_problem(null);
      set_notice(null);
      if (is_premium_diet(nextDiet) && !(await premium_or_problem(active))) return;
      if (!active()) return;
      // The standard recipe: the one kept from before, the regular recipe on screen, or, when the dish opened in a diet
      // version on its own, the bundled dish's regular recipe. Never a diet version.
      const regular = current.bundledId ? bundled_version(current.bundledId, null)?.recipe : undefined;
      const standard_now =
        standard ??
        (diet === null ? { recipe: base, ai: addition ? original_ai : current.ai } : regular ? { recipe: regular, ai: current.ai } : null);
      // Remembers the standard recipe the first time a diet version replaces it.
      const keep_standard = () => {
        if (same && !standard && standard_now) set_standard(standard_now);
      };
      // Back to the standard recipe this was opened with: it's already here.
      if (same && nextDiet === null && standard) {
        set_addition(null);
        set_original(null);
        set_diet(null);
        set_standard(null);
        set_current({ ...current, recipe: standard.recipe, ai: standard.ai, savedId: null });
        return;
      }
      // A dish from the bundled collection has hand-written vegetarian and vegan versions: shown at once, offline.
      const local = current.bundledId && same ? bundled_version(current.bundledId, nextDiet) : null;
      if (local) {
        keep_standard();
        set_addition(null);
        set_original(null);
        set_diet(nextDiet);
        if (local.already && nextDiet) set_notice(`This recipe is already ${nextDiet}.`);
        set_current({ ...current, recipe: local.recipe, savedId: null });
        return;
      }
      // A version the recipe already carries (the written non-alcoholic one) is used as it is, with no AI request.
      const written = same && nextDiet && standard_now ? curated_version(standard_now.recipe, nextDiet) : null;
      if (written && nextDiet) {
        keep_standard();
        set_addition(null);
        set_original(null);
        set_diet(nextDiet);
        set_notice(`Relish's own ${nextDiet} version of this recipe. Tap ${nextDiet} again for the original.`);
        set_current({ ...current, recipe: written, savedId: null, ai: standard_now?.ai });
        return;
      }
      // Another guess that Recipeak already has opens its own checked recipe, with no AI request.
      const other = !same && !nextDiet && guess ? find_bundled_dish(kind, guess.name) : null;
      const other_recipe = other && bundled_recipe(other);
      if (other && other_recipe) {
        set_addition(null);
        set_original(null);
        set_diet(null);
        set_standard(null);
        const photo = await bundled_photo_uri(other);
        if (!active()) return;
        set_current({
          ...current,
          recipe: other_recipe,
          selected: index,
          image: NO_IMAGE,
          localPhoto: photo,
          savedId: null,
          bundledId: other.id,
          ai: false,
        });
        return;
      }
      set_busy(true);
      try {
        const next = await api.recipe(guess?.name ?? recipe.title, kind, nextDiet ?? undefined);
        if (!active()) return;
        // Keep the original and its undo action until the replacement has actually arrived.
        if (same && nextDiet) keep_standard();
        else set_standard(null);
        set_addition(null);
        set_original(null);
        set_diet(nextDiet);
        // Anything the server writes is made with AI, and a different guess is no longer the bundled dish.
        set_current({
          ...current,
          recipe: next.recipe,
          selected: index,
          image: next.image,
          localPhoto: null,
          savedId: null,
          ai: true,
          ...(index !== selected ? { bundledId: undefined } : {}),
        });
      } catch (error) {
        if (!active()) return;
        if (error instanceof ApiError && error.needsUpgrade) router.push({ pathname: "/upgrade", params: { reason: error.upgradeReason } });
        else set_problem(error instanceof ApiError ? error.message : "Couldn't load that version. Please try again.");
      } finally {
        set_busy(false);
      }
    } finally {
      version_pending.current = false;
      set_busy(false);
    }
  }

  /** True for subscribers. Opens the Premium screen for free accounts, or explains when the plan can't be checked. */
  async function premium_or_problem(active: () => boolean): Promise<boolean> {
    try {
      const premium = await is_subscriber();
      if (!active()) return false;
      if (premium) return true;
      router.push({ pathname: "/upgrade", params: { reason: "versions" } });
    } catch {
      if (!active()) return false;
      set_problem("Couldn't check your plan. Please try again.");
    }
    return false;
  }

  async function load_addition(next: Addition) {
    if (busy || version_pending.current) return;
    version_pending.current = true;
    set_busy(true);
    try {
      set_problem(null);
      set_notice(null);
      // Tapping the one that's showing goes back to the recipe it was made from.
      if (next === addition && original) {
        set_addition(null);
        set_original(null);
        set_current({ ...current, recipe: original, savedId: null, ai: original_ai });
        return;
      }
      const active = recipe_requests.begin();
      if (!(await premium_or_problem(active)) || !active()) return;
      set_busy(true);
      try {
        const from = original ?? recipe;
        const made = await api.recipe_addition(dishName, next, from);
        if (!active()) return;
        set_original(from);
        set_original_ai(current.ai);
        set_addition(next);
        set_current({ ...current, recipe: made, savedId: null, ai: true });
      } catch (error) {
        if (!active()) return;
        if (error instanceof ApiError && error.needsUpgrade) router.push({ pathname: "/upgrade", params: { reason: error.upgradeReason } });
        else set_problem(error instanceof ApiError ? error.message : "Couldn't make that version. Please try again.");
      } finally {
        set_busy(false);
      }
    } finally {
      version_pending.current = false;
      set_busy(false);
    }
  }

  const after_save = useStoreReviewPrompt();
  async function toggle_save() {
    // One save or removal at a time: a double tap must not save twice or leave an extra photo behind.
    if (preferences.busy || busy || version_pending.current || saving.current) return;
    saving.current = true;
    const active = recipe_requests.begin();
    set_save_problem(null);
    try {
      if (current.savedId) {
        await saved.remove(current.savedId);
        if (!active()) return;
        set_current({ ...current, savedId: null });
      } else {
        // Saved with its cover photo, downloaded to the phone so Saved works offline. Free accounts keep up to 3
        // recipes, however they found them (a photo or the Home wall); photosLeft is null only for subscribers.
        const limit = (await is_subscriber()) ? undefined : FREE_SAVED_RECIPES;
        if (!active()) return;
        const entry = await saved.save(kind, recipe, preferences.ready && preferences.values.saveCoverPhotos ? coverUri : null, {
          limit,
          ai: current.ai,
          // The bundled photo, or the library photo's path, so the cover can always be found again.
          bundled_id: current.bundledId,
          image_url: current.image.status === "ready" ? current.image.url : cover.path,
        });
        if (!active()) return;
        set_current({ ...current, savedId: entry.id });
        set_just_saved(true);
        after_save();
      }
    } catch (error) {
      if (!active()) return;
      if (error instanceof SavedLimitError) router.push({ pathname: "/upgrade", params: { reason: "saved" } });
      else
        set_save_problem(
          error instanceof ApiError ? "Couldn't check your plan to save this recipe. Please try again." : (error as Error).message,
        );
    } finally {
      saving.current = false;
    }
  }

  async function is_subscriber(): Promise<boolean> {
    if (photosLeft !== undefined) return photosLeft === null;
    // Not known yet: ask the server. If it can't be reached, the save stops with a "try again" message, so it
    // neither lets a free account past its limit nor wrongly shows a subscriber the paywall.
    return (await api.allowance()).premium;
  }

  // A written version shown as a sentence (no ingredient list) can't be checked for other diets, so it offers only the
  // way back to the original rather than versions of a drink that may already fit them.
  const sentence_only = diet !== null && recipe.ingredients.length === 0;
  const choices = sentence_only
    ? [diet]
    : DIETS.filter((d) => profile.options.includes(d) || profile.status[d]?.status === "review" || d === diet);

  const fixed_yield = recipe.ingredients.length === 0;
  const footer = (
    <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 12 }]}>
      {save_problem && <Notice tone="error">{save_problem}</Notice>}
      <View style={styles.bottomRow}>
        <View style={styles.stepper}>
          {/* A version written as a sentence keeps its amounts in the method, which can't be scaled: its yield is fixed. */}
          {fixed_yield ? null : (
            <RoundButton icon="remove" label="Fewer servings" small onPress={() => set_servings(Math.max(1, servings - 1))} />
          )}
          <Text style={styles.servings} accessibilityLiveRegion="polite">
            Serves {servings}
          </Text>
          {fixed_yield ? null : (
            <RoundButton icon="add" label="More servings" small onPress={() => set_servings(Math.min(50, servings + 1))} />
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={current.savedId ? "Saved. Tap to remove from Saved" : "Save recipe"}
          accessibilityState={{ disabled: preferences.busy || busy }}
          disabled={preferences.busy || busy}
          onPress={toggle_save}
          style={({ pressed }) => [styles.save, current.savedId && styles.saved, pressed && { opacity: 0.8 }]}
        >
          <Ionicons
            name={current.savedId ? "bookmark" : "bookmark-outline"}
            size={20}
            color={current.savedId ? colors.text : colors.accentText}
          />
          <Text style={[styles.saveText, current.savedId && { color: colors.text }]}>{current.savedId ? "Saved" : "Save"}</Text>
        </Pressable>
      </View>
    </View>
  );

  return (
    <Sheet
      footer={footer}
      on_share={share_recipe}
      share_tip={
        just_saved && tips.is_due("share") ? (
          <TipBubble
            text="Saved. Tap share to send it to a friend."
            arrow="up"
            arrow_at="right"
            on_dismiss={() => tips.mark_seen("share")}
          />
        ) : null
      }
    >
      {/* "handled": with the keyboard up (the name box, or the report sheet, whose touches pass through this screen), a
          tap on a button works first time instead of only closing the keyboard. */}
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 110 + insets.bottom }}>
        {/* Cover photo from the shared library; the app's art shows while it's being created. */}
        <View style={[styles.cover, { width, height: coverHeight }]}>
          {coverUri ? (
            <FocusedCover uri={coverUri} width={width} height={coverHeight} label={`Photo of ${recipe.title}`} />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.placeholder]}>
              <Image source={heroArt} style={styles.placeholderArt} resizeMode="contain" accessible={false} />
              {cover.pending && (
                <View style={styles.creating}>
                  <ActivityIndicator color={colors.muted} size="small" />
                  <Text style={type.muted}>Creating photo…</Text>
                </View>
              )}
            </View>
          )}
          <LinearGradient colors={["rgba(0,0,0,0.4)", "rgba(0,0,0,0)"]} locations={[0, 0.3]} style={StyleSheet.absoluteFill} />
          {coverUri && (
            <View style={styles.aiLabel}>
              <Text style={styles.aiLabelText}>AI-generated image</Text>
            </View>
          )}
        </View>

        <View style={styles.body}>
          <Text style={styles.kicker}>{kind === "cocktail" ? "Drink" : "Meal"}</Text>
          <Text style={styles.title} accessibilityRole="header">
            {recipe.title}
          </Text>
          <Text style={[type.body, { marginTop: 8 }]}>{recipe.description}</Text>

          {guesses.length > 1 && (
            <>
              <Text style={[type.label, { marginTop: 20 }]}>CLOSEST MATCHES</Text>
              <View style={styles.matches}>
                {guesses.map((g, i) => (
                  <MatchCard
                    key={g.name}
                    kind={kind}
                    guess={g}
                    selected={i === selected}
                    onPress={() => i !== selected && load_version(i, null)}
                  />
                ))}
              </View>
            </>
          )}

          {!!guesses.length && !current.picked && <ManualCorrection initialKind={kind} />}

          <View style={styles.stats}>
            <Stat label="Prep" value={format_minutes(recipe.prep_minutes)} />
            <Stat label="Cook" value={format_minutes(recipe.cook_minutes)} />
            <Stat label="Serves" value={String(servings)} />
          </View>

          {busy && <Notice>Getting that version…</Notice>}
          {problem && <Notice tone="error">{problem}</Notice>}
          {notice && <Notice>{notice}</Notice>}
          {dietUnverified && <Notice>Check the ingredients and labels: this version could not be confirmed as {diet}.</Notice>}
          {tapHint.length > 0 && <Notice>For your diet, tap {or_list(tapHint)} below.</Notice>}
          {preferences.error && (
            <Notice>
              Offline cover preferences could not load. You can still save recipe text. Retry loading preferences in Settings.
            </Notice>
          )}

          {/* The labels describe the standard recipe, so they're hidden while a meat or dairy version is showing. */}
          {profile.fits.length > 0 && !addition && (
            <View style={{ marginTop: 16 }}>
              <Text style={type.body}>
                <Text style={{ fontWeight: "700" }}>Already </Text>
                {profile.fits.join(" · ")}
              </Text>
              <Text style={[type.muted, { marginTop: 4 }]}>
                {"From the ingredients. Check packaged ingredients' labels; this can't rule out cross-contact."}
              </Text>
            </View>
          )}
          {(choices.length > 0 || additions.length > 0) && (
            <>
              <Text style={type.heading}>Make it…</Text>
              <View style={styles.wrap}>
                {choices.map((d) => (
                  <Chip key={d} label={d} selected={d === diet} onPress={() => load_version(selected, d === diet ? null : d)} />
                ))}
                {additions.map((a) => (
                  <Chip key={a} label={a} selected={a === addition} onPress={() => void load_addition(a)} />
                ))}
              </View>
              {addition && <Notice>{`${ADDITION_HINTS[addition]}. Tap ${addition} again for the original recipe.`}</Notice>}
              {photosLeft !== null && (choices.some(is_premium_diet) || additions.length > 0) && (
                <Text style={[type.muted, { marginTop: 4 }]}>
                  {"Vegetarian, vegan, non-vegetarian and non-vegan versions are part of Premium."}
                </Text>
              )}
            </>
          )}

          {recipe.cocktail && (
            <View style={styles.serve}>
              <Ionicons name="wine-outline" size={22} color={colors.accentInk} />
              <Text style={[type.body, { flex: 1 }]}>
                Serve in a {recipe.cocktail.glass.toLowerCase()}
                {recipe.cocktail.garnish ? `, garnished with ${recipe.cocktail.garnish.toLowerCase()}` : ""}.
              </Text>
            </View>
          )}

          <View style={{ marginTop: 20 }}>
            <Button
              label={kind === "cocktail" ? "Start mixing" : "Start cooking"}
              onPress={() => router.push({ pathname: "/cook", params: { servings: String(servings) } })}
            />
          </View>
          <Text style={type.heading} accessibilityRole="header">
            Ingredients
          </Text>
          {recipe.ingredients.length === 0 && <Text style={type.body}>Everything you need is in the method below.</Text>}
          {recipe.ingredients.map((ingredient, i) => {
            const scaled = scale_amount(ingredient.amount, factor);
            const amount = [scaled, ingredient.unit].filter((p) => p.trim()).join(" ");
            return (
              <View key={i} style={styles.ingredient} accessible accessibilityLabel={format_ingredient({ ...ingredient, amount: scaled })}>
                <Text style={styles.amount}>{amount || "•"}</Text>
                <Text style={[type.body, { flex: 1 }]}>{ingredient.item}</Text>
              </View>
            );
          })}

          <Text style={type.heading} accessibilityRole="header">
            Steps
          </Text>
          {recipe.steps.map((step, i) => (
            <View key={i} style={styles.step} accessible accessibilityLabel={`Step ${i + 1}. ${step}`}>
              <Text style={styles.stepNumber}>{String(i + 1).padStart(2, "0")}</Text>
              <Text style={[type.body, { flex: 1 }]}>{step}</Text>
            </View>
          ))}

          {!!recipe.tips?.length && (
            <>
              <Text style={type.heading} accessibilityRole="header">
                Tips for success
              </Text>
              {recipe.tips.map((tip, i) => (
                <View key={i} style={styles.tip}>
                  <Ionicons name="bulb-outline" size={20} color={colors.accentInk} accessible={false} />
                  <Text style={[type.body, { flex: 1 }]}>{tip}</Text>
                </View>
              ))}
            </>
          )}
          {!!recipe.make_ahead && (
            <>
              <Text style={type.heading} accessibilityRole="header">
                Make ahead and storage
              </Text>
              <Text style={type.body}>{recipe.make_ahead}</Text>
            </>
          )}
          {!!recipe.variations?.length && (
            <>
              <Text style={type.heading} accessibilityRole="header">
                Variations
              </Text>
              {recipe.variations.map((variation, i) => (
                <View key={i} style={styles.tip}>
                  <Ionicons name="swap-horizontal-outline" size={20} color={colors.accentInk} accessible={false} />
                  <Text style={[type.body, { flex: 1 }]}>{variation}</Text>
                </View>
              ))}
            </>
          )}

          {recipe.cocktail?.non_alcoholic_version && (
            <>
              <Text style={type.heading}>Non-alcoholic version</Text>
              <Text style={type.body}>{recipe.cocktail.non_alcoholic_version}</Text>
            </>
          )}
          {!!recipe.note && (
            <>
              <Text style={type.heading}>Note</Text>
              <Text style={type.body}>{recipe.note}</Text>
            </>
          )}

          <Text style={type.heading}>Allergens</Text>
          <Text style={type.body}>
            {recipe.allergens.length ? `Contains ${recipe.allergens.join(", ")}.` : "None of the major allergens are listed."}
          </Text>
          {!!maybeAllergens && <Text style={[type.body, { marginTop: 4 }]}>{maybeAllergens}</Text>}
          <Text style={[type.muted, { marginTop: 4 }]}>
            {
              "A photo can't show every ingredient. Check labels if allergies matter. Leaving an ingredient out doesn't remove traces of it from shared kitchens or packaged foods."
            }
          </Text>

          <RateRecipe key={`${kind}|${dishName}`} kind={kind} dish={dishName} />

          <View style={styles.shareRow}>
            <Button label="Share recipe" variant="secondary" onPress={share_recipe} />
          </View>

          {current.ai && (
            <View style={{ marginTop: 16 }}>
              <Notice>
                Made with AI. Check every ingredient and allergen before you cook or serve it. Something wrong? Use &quot;Report this
                recipe&quot; below.
              </Notice>
            </View>
          )}
          <Text style={[type.muted, { marginTop: 16 }]}>
            This is a representative recipe for this {kind === "cocktail" ? "drink" : "dish"}, not the exact recipe from the restaurant or
            bar.
          </Text>

          <View style={{ marginTop: 16 }}>
            <ReportRecipe
              key={`${kind}|${dishName}|${diet ?? ""}`}
              kind={kind}
              dish={dishName}
              diet={diet}
              recipe={recipe}
              servings={servings}
            />
          </View>
        </View>
      </ScrollView>
    </Sheet>
  );
}

/**
 * "Not the right dish?": type its name instead. After a photo that couldn't be read (`correction`), the typed name
 * stands in for that photo and uses a free photo; on a recipe, it's a follow-up to the photo that worked.
 */
function ManualCorrection({ initialKind, correction = false }: { initialKind: Kind; correction?: boolean }) {
  const { set_current, current, recipe_requests } = useApp();
  const { colors, type } = useTheme();
  const [expanded, set_expanded] = useState(false);
  const [name, set_name] = useState("");
  const [kind, set_kind] = useState<Kind>(initialKind);
  const [busy, set_busy] = useState(false);
  const [error, set_error] = useState<string | null>(null);
  async function find_recipe() {
    const clean = name.trim();
    if (!clean || busy) return;
    set_busy(true);
    set_error(null);
    const active = recipe_requests.begin();
    try {
      // A dish Recipeak has opens its own recipe, with no AI request (and no free photo used).
      const dish = find_bundled_dish(kind, clean);
      const library = dish && bundled_recipe(dish);
      if (dish && library) {
        const localPhoto = await bundled_photo_uri(dish);
        if (!active()) return;
        set_current({
          status: "ready",
          kind,
          recipe: library,
          guesses: [{ name: dish.name, confidence: "high", image: NO_IMAGE }],
          selected: 0,
          image: NO_IMAGE,
          localPhoto,
          savedId: null,
          bundledId: dish.id,
        });
        set_expanded(false);
        return;
      }
      // Anything else asks first, like a photo of a dish Recipeak doesn't have: nothing is made or used until "yes".
      set_current({
        status: "ai-offer",
        kind,
        guesses: [{ name: clean, confidence: "high", image: NO_IMAGE }],
        typed: true,
        correction,
        previous: current,
      });
      set_expanded(false);
    } catch {
      if (!active()) return;
      set_error("Couldn't find that recipe. Please try again.");
    } finally {
      set_busy(false);
    }
  }
  return (
    <View style={{ marginTop: 18 }}>
      {!expanded ? (
        <Button label="Not the right dish? Enter its name" variant="secondary" onPress={() => set_expanded(true)} />
      ) : (
        <>
          <Text style={type.body}>Enter the name of your meal or cocktail</Text>
          <TextInput
            accessibilityLabel="Dish or cocktail name"
            value={name}
            onChangeText={set_name}
            maxLength={120}
            placeholder="e.g. chicken parmesan"
            placeholderTextColor={colors.muted}
            style={{
              minHeight: 48,
              fontSize: 16,
              color: colors.text,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 12,
              padding: 14,
              marginVertical: 8,
            }}
          />
          <View style={{ flexDirection: "row" }}>
            <Chip label="Meal" selected={kind === "meal"} onPress={() => set_kind("meal")} />
            <Chip label="Cocktail" selected={kind === "cocktail"} onPress={() => set_kind("cocktail")} />
          </View>
          {error && <Notice tone="error">{error}</Notice>}
          <Button label="Find recipe" disabled={!name.trim()} busy={busy} onPress={find_recipe} />
          <Button label="Cancel" variant="secondary" disabled={busy} onPress={() => set_expanded(false)} />
        </>
      )}
    </View>
  );
}

/** One of the closest matches, with its own cover photo. */
function MatchCard({ kind, guess, selected, onPress }: { kind: Kind; guess: Guess; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(create_styles);
  const { api } = useApp();
  const { uri } = useDishImage(api, kind, guess.name, guess.image);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={guess.name}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.match, selected && styles.matchSelected, pressed && { opacity: 0.8 }]}
    >
      <View style={styles.matchImage}>
        {uri ? (
          <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <Image source={heroArt} style={{ width: "80%", height: "80%" }} resizeMode="contain" />
        )}
      </View>
      <Text style={[styles.matchName, selected && { color: colors.accentInk }]} numberOfLines={2}>
        {guess.name}
      </Text>
    </Pressable>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const { type } = useTheme();
  const styles = useThemedStyles(create_styles);
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={type.label}>{label.toUpperCase()}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function RoundButton({
  icon,
  label,
  onPress,
  small,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  small?: boolean;
}) {
  const styles = useThemedStyles(create_styles);
  const size = small ? 44 : 46;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.round, { width: size, height: size, borderRadius: size / 2 }, pressed && { opacity: 0.7 }]}
    >
      <Ionicons name={icon} size={small ? 22 : 26} color="#FFFFFF" />
    </Pressable>
  );
}

const create_styles = (colors: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    handle: {
      position: "absolute",
      top: 8,
      alignSelf: "center",
      width: 44,
      height: 5,
      borderRadius: 3,
      backgroundColor: "rgba(255,255,255,0.4)",
      zIndex: 2,
    },
    cover: { backgroundColor: colors.surface, overflow: "hidden" },
    placeholder: { backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
    placeholderArt: { width: "70%", height: "60%", opacity: 0.85 },
    creating: { position: "absolute", bottom: 14, flexDirection: "row", alignItems: "center", gap: 8 },
    aiLabel: {
      position: "absolute",
      right: 10,
      bottom: 10,
      backgroundColor: "rgba(0,0,0,0.55)",
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    aiLabelText: { color: "#E4E4E7", fontSize: 11 },
    body: { paddingHorizontal: 20 },
    findingRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 20, marginBottom: 18 },
    skeleton: { height: 16, borderRadius: 8, backgroundColor: colors.surface, marginBottom: 12 },
    kicker: { color: colors.accentInk, fontSize: 12, fontWeight: "700", letterSpacing: 1.2, textTransform: "uppercase", marginTop: 18 },
    title: { color: colors.text, fontSize: 28, lineHeight: 34, fontFamily: fonts.display, marginTop: 4 },
    matches: { flexDirection: "row", gap: 10, marginTop: 10 },
    match: { flex: 1, borderRadius: 14, padding: 6, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: "transparent" },
    matchSelected: { borderColor: colors.accentInk },
    matchImage: {
      aspectRatio: 1,
      borderRadius: 10,
      overflow: "hidden",
      backgroundColor: colors.raised,
      alignItems: "center",
      justifyContent: "center",
    },
    matchName: { color: colors.text, fontSize: 13, fontWeight: "600", marginTop: 6, minHeight: 34 },
    stats: { flexDirection: "row", marginTop: 20, backgroundColor: colors.surface, borderRadius: 18, paddingVertical: 14 },
    stat: { flex: 1, alignItems: "center" },
    statValue: { color: colors.text, fontSize: 16, fontWeight: "600", marginTop: 4 },
    wrap: { flexDirection: "row", flexWrap: "wrap" },
    serve: {
      flexDirection: "row",
      gap: 12,
      alignItems: "center",
      marginTop: 20,
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 14,
    },
    ingredient: {
      flexDirection: "row",
      gap: 14,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    amount: { color: colors.accentInk, fontSize: 16, fontWeight: "700", minWidth: 76 },
    step: { flexDirection: "row", gap: 16, marginBottom: 20 },
    tip: { flexDirection: "row", gap: 12, marginBottom: 12 },
    stepNumber: { color: colors.accentInk, fontSize: 24, lineHeight: 28, fontFamily: fonts.displayMedium, minWidth: 36 },
    shareRow: { marginTop: 16 },
    shareTip: { position: "absolute", left: 16, right: 16 },
    topBar: { position: "absolute", left: 16, right: 16, flexDirection: "row", justifyContent: "space-between" },
    round: { backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center" },
    bottomBar: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      gap: 8,
      paddingHorizontal: 16,
      paddingTop: 12,
      backgroundColor: colors.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    bottomRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    statusBand: { position: "absolute", top: 0, left: 0, right: 0, backgroundColor: colors.background },
    stepper: { flexDirection: "row", alignItems: "center", gap: 10 },
    servings: { color: colors.text, fontSize: 15, fontWeight: "600", minWidth: 74, textAlign: "center" },
    save: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: colors.accent,
      borderRadius: 24,
      minHeight: 48,
      paddingHorizontal: 20,
    },
    saved: { backgroundColor: colors.raised },
    saveText: { color: colors.accentText, fontSize: 16, fontWeight: "700" },
  });
