import type { PluginHandlerContext, PluginLifecycleEvents, PluginSettings } from "@getpaseo/plugin/server";
import { activitySettings, turnTimeFromValues } from "../shared/settings";
import { TURN_TIME_RENDERER_KIND, TURN_TIME_RENDERER_VERSION, turnTimeDataSchema } from "../shared/turn-time";

type Settings = PluginSettings<typeof activitySettings.schema>;
type Paseo = PluginHandlerContext["paseo"];

/**
 * 本地补丁：每一轮结束时，在该轮末尾追加一行时间。
 *
 * 位置为什么定在「整轮末尾」：daemon 的时间线写入只有 append（`agent.timeline.append.request`），**没有按位置插入的
 * 接口**，一行写下去位置就定了。于是一行能落在哪里，完全取决于「什么时候写」：
 *
 * - 想落在某段文字的正下方（它后面那些命令之前）：做不到。命令行由 Paseo 在命令**开始**时就记下了，插件收到通知时
 *   它已经在时间线里，插件只能写在它后面。
 * - 想落在「这一段的最后一条命令之后、下一段文字之前」：做不到。这要求写在「最后一条命令已记录、下一段文字还没开始」
 *   的窗口里，而这个窗口就是模型两步之间的思考时间，可能几十毫秒、也可能不存在。用定时器去赌，就会出现同一段文字
 *   有时写在第一条命令后、有时写在第二条命令后——也就是你看到的那种「插在两个命令之间」。
 * - 整轮末尾：能做到，而且是确定的。钩子在整轮结束时触发，此后这一轮不会再产生新的内容，写下的行必然落在这一轮所有
 *   内容之后。
 *
 * 所以这里每个 turn 写一行，取钩子触发的时刻，附在这一轮末尾。这也是最初的需求：每一轮后面显示这一轮的时间。
 */
export class TurnTimePublisher {
  private readonly settings: Settings;
  /** null until the stored switch is known; a write always waits for it. */
  private enabled: boolean | null = null;
  private ready: Promise<void> = Promise.resolve();
  private stopSettings: (() => void) | null = null;
  private stopped = false;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  /** Reads the switch once and follows later changes. */
  start(): void {
    this.ready = this.settings
      .read()
      .then((state) => {
        if (!this.stopped) this.enabled = state.status === "ready" && turnTimeFromValues(state.values);
      })
      .catch(() => undefined);
    try {
      this.stopSettings = this.settings.subscribe((state) => {
        this.enabled = state.status === "ready" && turnTimeFromValues(state.values);
      });
    } catch {
      this.stopSettings = null;
    }
  }

  dispose(): void {
    this.stopped = true;
    this.stopSettings?.();
    this.stopSettings = null;
  }

  /** One row for a finished turn, carrying the moment it ended. */
  async finish(event: PluginLifecycleEvents["agent.turn_ended"], context: PluginHandlerContext): Promise<void> {
    await this.ready;
    if (!this.enabled || this.stopped) return;
    // 钩子触发的时刻就是这一轮结束的时刻。
    const at = Date.now();
    const data = turnTimeDataSchema.parse({ at, turnId: event.turnId, outcome: event.outcome.kind });
    await this.append(context.paseo, event.agent.id, `${event.turnId ?? "turn"}-end`, data);
  }

  private async append(
    paseo: Paseo,
    agentId: string,
    id: string,
    data: ReturnType<typeof turnTimeDataSchema.parse>,
  ): Promise<void> {
    try {
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id,
        kind: TURN_TIME_RENDERER_KIND,
        version: TURN_TIME_RENDERER_VERSION,
        data,
      });
    } catch (error) {
      // 未加载的 Agent（例如子 Agent 自己的会话）读不到时间线：静默跳过，不刷日志。
      const message = error instanceof Error ? error.message : String(error);
      if (!/unknown agent|not found/i.test(message)) {
        console.error("vivid-activity: turn time row unavailable", agentId, error);
      }
    }
  }
}
