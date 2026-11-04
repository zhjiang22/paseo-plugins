import { useSettings } from "@getpaseo/plugin/client";
import { activitySettings } from "../shared/settings";

/**
 * 0.11.0:展开区域的设置读取钩子。放在中立模块：常驻行（activity.tsx）与懒加载详情
 * （activity-details.tsx）都要用，且不能让常驻侧静态引入详情块。
 */

/** 「长行折行」矩阵（shared/settings.ts wrapLines）。off（默认）= 单行横滚；on = 折到可用宽度。 */
export function useWrapLines(area: "diff" | "code" | "output"): boolean {
  const settings = useSettings(activitySettings);
  // 兜底旧形状 values（未经 migrate 的测试夹具等）：缺矩阵按默认。
  if (settings.status !== "ready") return false;
  return settings.values.wrapLines?.[area] ?? false;
}

/** 「跟随最新输出」矩阵（shared/settings.ts followOutput；思考行走 thoughtTail*，不在此）。 */
export function useFollowOutput(area: "shell" | "logs" | "todo"): boolean {
  const settings = useSettings(activitySettings);
  if (settings.status !== "ready") return true;
  return settings.values.followOutput?.[area] ?? true;
}
