import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Text } from "react-native";
import { highlightCodeSync } from "./highlight";

/**
 * 0.11.0:「命令着色」：shell 行的行头命令按语法色渲染。只活在 fx 懒加载块里（Prism 不进常驻包）；
 * token 少于一色（普通词）或高亮不可用时返回纯文本。颜色来自宿主主题（前景/弱化/强调三色）。
 */
export function CommandTokens({ text, theme }: { text: string; theme: PluginTheme }): ReactNode {
  const lines = highlightCodeSync(text, "shell", {
    foreground: theme.colors.foreground,
    foregroundMuted: theme.colors.foregroundMuted,
    accent: theme.colors.accent,
  });
  const line = lines?.[0];
  if (!line || line.length <= 1) return text;
  return (
    <>
      {line.map((token, index) => (
        <Text key={index} style={token.color ? { color: token.color } : null}>{token.content}</Text>
      ))}
    </>
  );
}
