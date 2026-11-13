import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";

// Small building blocks for Ferry's views, coloured from the host's theme only.

export type Tone = "accent" | "muted" | "success" | "warning" | "danger";

export function toneColor(theme: PluginTheme, tone: Tone): string {
  const colors = theme.colors;
  return tone === "accent" ? colors.accent : tone === "success" ? colors.statusSuccess : tone === "warning" ? colors.statusWarning : tone === "danger" ? colors.statusDanger : colors.foregroundMuted;
}

export function Button(props: { theme: PluginTheme; label: string; onPress(): void; kind?: "primary" | "secondary" | "link"; disabled?: boolean; busy?: boolean; testID?: string }) {
  const { theme, kind = "secondary", disabled } = props;
  const colors = theme.colors;
  const primary = kind === "primary";
  const link = kind === "link";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!disabled, busy: !!props.busy }}
      disabled={disabled || props.busy}
      onPress={props.onPress}
      testID={props.testID}
      style={({ pressed }) => ({
        paddingVertical: link ? 2 : 10,
        paddingHorizontal: link ? 0 : 14,
        borderRadius: 8,
        borderWidth: primary || link ? 0 : 1,
        borderColor: colors.border,
        backgroundColor: primary ? colors.accent : link ? "transparent" : colors.surface1,
        opacity: disabled ? 0.5 : pressed ? 0.75 : 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        alignSelf: link ? "flex-start" : undefined,
      })}
    >
      {props.busy ? <ActivityIndicator color={primary ? colors.accentForeground : colors.foregroundMuted} size="small" /> : null}
      <Text style={{ color: primary ? colors.accentForeground : link ? colors.accent : colors.foreground, fontSize: 14, fontWeight: primary ? "600" : "500", textDecorationLine: link ? "underline" : "none" }}>{props.label}</Text>
    </Pressable>
  );
}

export function Badge(props: { theme: PluginTheme; text: string; tone?: Tone; testID?: string }) {
  const color = toneColor(props.theme, props.tone ?? "muted");
  return (
    <View testID={props.testID} style={{ borderWidth: 1, borderColor: color, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 }}>
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{props.text}</Text>
    </View>
  );
}

export function Heading(props: { theme: PluginTheme; text: string; size?: "large" | "small" }) {
  const large = props.size === "large";
  return <Text style={{ color: large ? props.theme.colors.foreground : props.theme.colors.foregroundMuted, fontSize: large ? 20 : 12, fontWeight: large ? "600" : "700", letterSpacing: large ? 0 : 0.5, textTransform: large ? "none" : "uppercase" }}>{props.text}</Text>;
}

export function Muted(props: { theme: PluginTheme; children: ReactNode; testID?: string }) {
  return (
    <Text testID={props.testID} style={{ color: props.theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>
      {props.children}
    </Text>
  );
}

export function Body(props: { theme: PluginTheme; children: ReactNode; testID?: string }) {
  return (
    <Text testID={props.testID} style={{ color: props.theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>
      {props.children}
    </Text>
  );
}

export function Card(props: { theme: PluginTheme; children: ReactNode; tone?: Tone; testID?: string }) {
  const colors = props.theme.colors;
  return (
    <View testID={props.testID} style={{ borderWidth: 1, borderColor: props.tone ? toneColor(props.theme, props.tone) : colors.border, borderRadius: 10, padding: 12, gap: 8, backgroundColor: colors.surface1 }}>
      {props.children}
    </View>
  );
}

/** A list of notes, each worded on this device; warnings in the warning colour. */
export function Notes(props: { theme: PluginTheme; lines: readonly string[]; tone?: Tone; testID?: string }) {
  if (!props.lines.length) return null;
  const color = props.tone ? toneColor(props.theme, props.tone) : props.theme.colors.foregroundMuted;
  return (
    <View testID={props.testID} style={{ gap: 4 }}>
      {props.lines.map((line, index) => (
        <Text key={index} style={{ color, fontSize: 13, lineHeight: 19 }}>
          • {line}
        </Text>
      ))}
    </View>
  );
}
