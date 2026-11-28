import { useKeepAwake } from "expo-keep-awake";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { useApp } from "../AppContext";
import { possible_allergen_line } from "../recipes/allergenRisk";
import { format_ingredient } from "../recipes/format";
import { scale_amount } from "../recipes/scale";
import { Button, useTheme } from "../ui/theme";

function KeepScreenAwake() {
  useKeepAwake("cooking-mode");
  return null;
}

export default function CookScreen() {
  const { current } = useApp();
  const { servings: selectedServings } = useLocalSearchParams<{ servings?: string }>();
  const { colors, type } = useTheme();
  const [step, set_step] = useState(0);
  const [checked, set_checked] = useState<number[]>([]);
  const [awake, set_awake] = useState(false);
  const [minutes, set_minutes] = useState("5");
  const [ends, set_ends] = useState<number | null>(null);
  const [now, set_now] = useState(0);
  useEffect(() => {
    if (ends === null) return;
    const tick = () => set_now(Date.now());
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [ends]);
  if (!current || current.status !== "ready")
    return (
      <View style={{ flex: 1, padding: 20, backgroundColor: colors.background }}>
        <Text style={type.body}>Open a recipe to start cooking.</Text>
        <Button label="Go back" onPress={() => router.back()} />
      </View>
    );
  const { recipe } = current;
  const maybeAllergens = possible_allergen_line(recipe);
  const servings = Math.max(1, Math.min(50, Number(selectedServings) || recipe.servings || 1));
  const factor = servings / (recipe.servings || 1);
  // Whole minutes only: "0" or "0.5" would finish the moment it starts.
  const timer_minutes = Math.floor(Number(minutes));
  const timer_ready = timer_minutes >= 1 && timer_minutes <= 999;
  const has_steps = recipe.steps.length > 0;
  const seconds = ends === null ? 0 : Math.max(0, Math.ceil((ends - now) / 1000));
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 20, gap: 14, paddingBottom: 40 }}>
      {awake && <KeepScreenAwake />}
      <Text style={type.title} accessibilityRole="header">
        {recipe.title}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={type.body}>Keep screen awake</Text>
        <Switch
          accessibilityLabel="Keep screen awake"
          value={awake}
          onValueChange={set_awake}
          trackColor={{ true: colors.accent, false: colors.raised }}
          thumbColor="#FFFFFF"
        />
      </View>
      {has_steps && (
        <Text style={type.label}>
          STEP {step + 1} OF {recipe.steps.length}
        </Text>
      )}
      <Text style={{ color: colors.text, fontSize: 24, lineHeight: 36 }} accessibilityLiveRegion="polite">
        {recipe.steps[step] ?? "No steps available."}
      </Text>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Button label="Back" variant="secondary" disabled={step === 0} onPress={() => set_step(Math.max(0, step - 1))} />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            label={step >= recipe.steps.length - 1 ? "Done" : "Next"}
            onPress={() => (step >= recipe.steps.length - 1 ? router.back() : set_step(step + 1))}
          />
        </View>
      </View>
      <Text style={type.heading}>Timer</Text>
      <Text style={type.muted}>Timer runs while this screen is open. Keep the app open to see it finish.</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <TextInput
          accessibilityLabel="Timer minutes"
          keyboardType="number-pad"
          value={minutes}
          onChangeText={set_minutes}
          maxLength={3}
          style={{ minWidth: 70, color: colors.text, backgroundColor: colors.surface, padding: 12, borderRadius: 10 }}
        />
        <Text style={type.body}>minutes</Text>
        <Text accessibilityLiveRegion="polite" style={type.title}>
          {ends === null ? "" : seconds ? time : "Time's up!"}
        </Text>
      </View>
      <Button
        label={ends !== null ? "Reset timer" : "Start timer"}
        disabled={ends === null && !timer_ready}
        onPress={() => {
          if (ends !== null) set_ends(null);
          else {
            const currentTime = Date.now();
            set_now(currentTime);
            set_ends(currentTime + timer_minutes * 60000);
          }
        }}
      />
      <Text style={type.heading}>Ingredients · serves {servings}</Text>
      {recipe.ingredients.map((ingredient, index) => {
        const label = format_ingredient({ ...ingredient, amount: scale_amount(ingredient.amount, factor) });
        return (
          <Pressable
            key={index}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: checked.includes(index) }}
            accessibilityLabel={label}
            onPress={() => set_checked(checked.includes(index) ? checked.filter((i) => i !== index) : [...checked, index])}
            style={{ paddingVertical: 10 }}
          >
            <Text style={[type.body, checked.includes(index) && { textDecorationLine: "line-through", color: colors.muted }]}>
              {checked.includes(index) ? "☑" : "☐"} {label}
            </Text>
          </Pressable>
        );
      })}
      <Text style={type.muted}>
        Allergens: {recipe.allergens.length ? recipe.allergens.join(", ") : "None listed"}. Check ingredient labels if allergies matter.
      </Text>
      {/* The same brand-dependent warning as the recipe screen and shared text (recipe.tsx, format.ts). */}
      {!!maybeAllergens && <Text style={type.muted}>{maybeAllergens}</Text>}
    </ScrollView>
  );
}
