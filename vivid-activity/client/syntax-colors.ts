import type { PluginTheme } from "@getpaseo/plugin";
import type { ThemeSyntaxColors } from "./highlight";
import { hue } from "./kit";

/** 0.11.0:「命令着色」的 vivid 派生语法色：10 种 shell token kind → 调色板 hue（命令橙/关键字紫/字符串绿/变量青…）。
 *  仅命令着色路径（CommandTokens/shellSegments）传入；其余代码高亮走既有 3 色通道。
 *  不放在 kit.tsx：那是 kit/ 的共享副本（npm run kit:sync 覆盖），只放各插件共用的部分。 */
export function vividSyntaxColors(theme: PluginTheme): ThemeSyntaxColors {
  return {
    foreground: theme.colors.foreground,
    foregroundMuted: theme.colors.foregroundMuted,
    accent: hue(theme, "violet", "text"),
    statusSuccess: hue(theme, "green", "text"),
    statusWarning: hue(theme, "amber", "text"),
    statusDanger: hue(theme, "red", "text"),
    builtin: hue(theme, "orange", "text"),
    keyword: hue(theme, "violet", "text"),
    variable: hue(theme, "cyan", "text"),
    operator: hue(theme, "sky", "text"),
    parameter: hue(theme, "indigo", "text"),
    // 0.11.0:boolean/constant 拆出紫（青柠）、heredoc 原始块用鸭羽绿——都避开红/蓝状态语义色。
    constant: hue(theme, "lime", "text"),
    heredoc: hue(theme, "teal", "text"),
  };
}
