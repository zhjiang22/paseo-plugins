import { LanguageSettings } from "./language-settings";
import { t } from "../shared/text";
import { PreviewCard } from "./preview-card";
import { useMemo, useState, type ComponentType } from "react";
import { Text } from "react-native";
import {
  useSettings,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  activitySettings,
  DEFAULT_EXPANSION,
  densitySchema,
  expansionModeSchema,
  loaderSchema,
  paletteModeSchema,
  strengthSchema,
  commandColorsSchema,
  takeoverScopeSchema,
  visibleExpansionTargets,
} from "../shared/settings";
import type { Density, ExpansionMode, ExpansionTarget, LoaderKind, Strength, TakeoverScope } from "../shared/settings";
import { LOADER_KINDS } from "../shared/settings";
import type { ActivityPalette } from "../shared/presentation";
import type { PaletteMode } from "../shared/settings";
import { toneColor } from "./kit";
import { cmonoTextEscape } from "./web";
import { LoaderPreview, loaderLabels } from "./loader-preview";
import { LINE_SPACINGS, monoFontStack, TEXT_SIZES, type LineSpacing, type TextSize } from "../shared/typography";
import { typesetStyle, useTypography } from "./typography";

export interface SettingsActions {
  onFoldSettings(value: { enabled?: boolean; scope?: TakeoverScope }): void;
  onTakeover(scope: TakeoverScope): void;
  /** 0.8.0: the resident's running mark (client/vivid.tsx LoaderMark), so the previews use the fx chunk it loads. */
  LoaderMark?: ComponentType<{ kind: LoaderKind; size: number; color: string }>;
}

type ReadySettings = Extract<SettingsState<typeof activitySettings.schema>, { status: "ready" }>;

const takeoverOptions = [
  { value: "all", get label() { return t("settings.all"); } },
  { value: "reasoning", get label() { return t("settings.thinkingRowsOnly"); } },
  { value: "off", get label() { return t("settings.off"); } },
];

const takeoverDescriptions: Record<TakeoverScope, string> = {
  get all() { return t("settings.replaceThinkingAndToolCall"); },
  get reasoning() { return t("settings.redrawThinkingRowsOnlyPaseo"); },
  get off() { return t("settings.letPaseoDisplayAllRows"); },
};



const paletteOptions = [
  { value: "vivid", get label() { return t("settings.vivid"); } },
  { value: "theme", get label() { return t("settings.followThemeColors"); } },
  { value: "soft", get label() { return t("settings.soft"); } },
  { value: "high_contrast", get label() { return t("settings.highContrast"); } },
];

const paletteDescriptions = {
  get vivid() { return t("settings.eachToolCategoryHasA"); },
  get theme() { return t("settings.theOriginalColorfulAgentActivity"); },
  get soft() { return t("settings.iconsAreMostlyNeutralOnly"); },
  get high_contrast() { return t("settings.thickerSeparatorsAndStrongerStatus"); },
} as const;

const expansionOptions = [
  { value: "always", get label() { return t("settings.alwaysExpand"); } },
  { value: "latest", get label() { return t("settings.expandLatestOnly"); } },
  { value: "failures", get label() { return t("settings.expandFailedRows"); } },
  { value: "never", get label() { return t("settings.collapsedByDefault"); } },
];

const expansionDescriptions = {
  get always() { return t("settings.expandEveryRowOldAnd"); },
  get latest() { return t("settings.expandOnlyTheLatestRow"); },
  get failures() { return t("settings.expandFailedRowsHint"); },
  get never() { return t("settings.startCollapsedEvenWhileRunning"); },
} as const;

function expansionDescription(target: ExpansionTarget, mode: ExpansionMode): string {
  if (target !== "todo") return expansionDescriptions[mode];
  if (mode === "always") return t("settings.alwaysExpandTaskListTool");
  if (mode === "never") return t("settings.startTaskListToolRows");
  // failures 对任务清单等同收起；其余档位有专属文案。
  if (mode === "failures") return t("settings.startTaskListToolRows");
  return t("settings.expandOnlyTheLatestTask");
}

function TakeoverControls({ settings, actions }: { settings: ReadySettings; actions: SettingsActions }) {
  const scope = settings.values.takeover;
  const changeScope = (value: string) => {
    const parsed = takeoverScopeSchema.safeParse(value);
    if (!parsed.success || parsed.data === scope) return;
    const next = parsed.data;
    void settings.save({ ...settings.values, takeover: next }, settings.revision).then((saved) => {
      if (!saved) return;
      actions.onFoldSettings({ scope: next });
      actions.onTakeover(next);
    });
  };
  return (
    <SettingsSection title={t("settings.takeoverScope")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.takeover")}
          hint={takeoverDescriptions[scope]}
          value={scope}
          options={takeoverOptions}
          disabled={settings.saving}
          onValueChange={changeScope}
        />
        {scope === "all" ? <SettingsRow label={t("settings.tradeoffsOfReplacingToolRows")} hint={t("settings.takeoverCosts")} /> : null}
        <SettingsRow
          label={t("settings.alwaysDisplayedByPaseo")}
          hint={t("settings.planCardsTaskRowsApproval")}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

const densityOptions = [
  { value: "compact", get label() { return t("settings.compact"); } },
  { value: "standard", get label() { return t("settings.standard"); } },
];

const densityDescriptions: Record<Density, string> = {
  get compact() { return t("settings.shorterRowsWith4Px"); },
  get standard() { return t("settings.theSameRowHeightAnd"); },
};

/** 档位标签用百分比，各语言通用；说明走文案。 */
const strengthOptions = [
  { value: "dim", label: "30%" },
  { value: "faded", label: "45%" },
  { value: "soft", label: "65%" },
  { value: "full", label: "100%" },
];

const strengthDescriptions: Record<Strength, string> = {
  get dim() { return t("settings.strengthDim"); },
  get faded() { return t("settings.strengthFaded"); },
  get soft() { return t("settings.strengthSoft"); },
  get full() { return t("settings.strengthFull"); },
};



function foldScopeNote(scope: TakeoverScope): string | null {
  if (scope === "reasoning") return t("settings.onlyThinkingRowsAreTaken");
  if (scope === "off") return t("settings.takeoverIsOffFoldingAnd");
  return null;
}

function FoldControls({ settings, actions }: { settings: ReadySettings; actions: SettingsActions }) {
  const fold = settings.values.fold;
  const density = settings.values.density;
  const note = foldScopeNote(settings.values.takeover);
  const changeFold = (value: boolean) => {
    if (value === fold) return;
    void settings.save({ ...settings.values, fold: value }, settings.revision).then((saved) => {
      if (saved) actions.onFoldSettings({ enabled: value });
    });
  };
  const changeDensity = (value: string) => {
    const parsed = densitySchema.safeParse(value);
    if (!parsed.success || parsed.data === density) return;
    void settings.save({ ...settings.values, density: parsed.data }, settings.revision);
  };
  const strength = settings.values.strength;
  const changeStrength = (value: string) => {
    const parsed = strengthSchema.safeParse(value);
    if (!parsed.success || parsed.data === strength) return;
    void settings.save({ ...settings.values, strength: parsed.data }, settings.revision);
  };
  const pinPrompt = settings.values.pinPrompt;
  const changePin = (value: boolean) => {
    if (value === pinPrompt) return;
    void settings.save({ ...settings.values, pinPrompt: value }, settings.revision);
  };
  return (
    <SettingsSection title={t("settings.foldingSpacingAndPrompts")}>
      <SettingsCard>
        <SettingsSwitch
          label={t("settings.foldConsecutiveThinkingAndTool")}
          hint={t("settings.foldHint")}
          value={fold}
          disabled={settings.saving}
          onValueChange={changeFold}
        />
        <SettingsSelect
          label={t("settings.rowDensity")}
          hint={densityDescriptions[density]}
          value={density}
          options={densityOptions}
          disabled={settings.saving}
          onValueChange={changeDensity}
        />
        {/* 接管关闭时插件不画任何行，淡出强度无从谈起，因此不列出（折叠与行密度仍显示，恢复接管后生效）。 */}
        {settings.values.takeover !== "off" ? (
          <SettingsSelect
            label={t("settings.strength")}
            hint={strengthDescriptions[strength]}
            value={strength}
            options={strengthOptions}
            disabled={settings.saving}
            onValueChange={changeStrength}
          />
        ) : null}
        <SettingsSwitch
          label={t("settings.pinThisTurnSPrompt")}
          hint={t("settings.pinHint")}
          value={pinPrompt}
          disabled={settings.saving}
          onValueChange={changePin}
        />
        {note ? <SettingsRow label={t("settings.takeoverScope")} hint={note} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function ExpansionControls({ settings }: { settings: ReadySettings }) {
  const changeExpansion = (target: ExpansionTarget) => (value: string) => {
    const parsed = expansionModeSchema.safeParse(value);
    if (!parsed.success) return;
    const mode: ExpansionMode = parsed.data;
    void settings.save(
      { ...settings.values, expansion: { ...DEFAULT_EXPANSION, ...settings.values.expansion, [target]: mode } },
      settings.revision,
    );
  };
  return (
    <SettingsSection title={t("settings.expansion")}>
      <SettingsCard>
        {visibleExpansionTargets(settings.values.takeover).map((target) => {
          const mode = settings.values.expansion?.[target.key] ?? target.default;
          return (
            <SettingsSelect
              key={target.key}
              label={target.label}
              hint={expansionDescription(target.key, mode)}
              value={mode}
              options={expansionOptions}
              disabled={settings.saving}
              onValueChange={changeExpansion(target.key)}
            />
          );
        })}
      </SettingsCard>
    </SettingsSection>
  );
}

function PaletteControls({ settings, theme, actions }: { settings: ReadySettings; theme: PluginSurfaceProps["theme"]; actions: SettingsActions }) {
  const errorStyle = useMemo(
    () => ({ color: toneColor(theme, "danger"), fontSize: 13, lineHeight: 18 }),
    [theme],
  );
  const changePalette = (value: string) => {
    const parsed = paletteModeSchema.safeParse(value);
    if (!parsed.success) return;
    void settings.save({ ...settings.values, palette: parsed.data }, settings.revision);
  };
  const loader = settings.values.loader;
  const changeLoader = (value: string) => {
    const parsed = loaderSchema.safeParse(value);
    if (!parsed.success || parsed.data === loader) return;
    void settings.save({ ...settings.values, loader: parsed.data }, settings.revision);
  };
  return (
    <SettingsSection title={t("settings.colors")}>
      <SettingsCard>
        {settings.values.takeover === "off" ? (
          <SettingsRow label={t("settings.takeoverIsOff")} hint={t("settings.theseColorsAndExpansionSettings")} />
        ) : null}
        <SettingsSelect
          label={t("settings.palette")}
          hint={paletteDescriptions[settings.values.palette]}
          value={settings.values.palette}
          options={paletteOptions}
          disabled={settings.saving}
          onValueChange={changePalette}
        />
        <SettingsSelect
          label={t("settings.runningAnimation")}
          hint={t("settings.loaderHint")}
          value={loader}
          options={LOADER_KINDS.map((kind) => ({ value: kind, label: loaderLabels[kind] }))}
          disabled={settings.saving}
          onValueChange={changeLoader}
        />
        <LoaderPreview theme={theme} value={loader} disabled={settings.saving} onChange={changeLoader} Mark={actions.LoaderMark} />
      </SettingsCard>
      {settings.saveError ? <Text accessibilityRole="alert" style={errorStyle}>{settings.saveError}</Text> : null}
    </SettingsSection>
  );
}

const textSizeLabels: Record<TextSize, () => string> = {
  small: () => t("settings.sizeSmall"),
  standard: () => t("settings.sizeStandard"),
  large: () => t("settings.sizeLarge"),
  larger: () => t("settings.sizeLarger"),
};

const lineSpacingLabels: Record<LineSpacing, () => string> = {
  compact: () => t("settings.compact"),
  standard: () => t("settings.standard"),
  relaxed: () => t("settings.relaxed"),
};

/** 0.9.0 (issue #3): font family, size and line spacing of the rows' code text (shared/typography.ts). */
function FontControls({ settings, theme }: { settings: ReadySettings; theme: PluginSurfaceProps["theme"] }) {
  const saved = settings.values.monoFont;
  const [draft, setDraft] = useState(saved);
  const [shown, setShown] = useState(saved);
  // A save from this or another device remounts the input (key) with the stored value; the draft follows it.
  if (shown !== saved) {
    setShown(saved);
    setDraft(saved);
  }
  const valid = monoFontStack(draft) !== null;
  const type = useTypography();
  const preview = useMemo(
    () => typesetStyle({ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12, lineHeight: 17 }, type),
    [theme.colors.foreground, type],
  );
  const apply = () => {
    const value = draft.trim();
    if (!valid || value === saved) return;
    void settings.save({ ...settings.values, monoFont: value }, settings.revision);
  };
  const change = (key: "textSize" | "lineSpacing", options: readonly string[]) => (value: string) => {
    if (!options.includes(value) || value === settings.values[key]) return;
    void settings.save({ ...settings.values, [key]: value }, settings.revision);
  };
  return (
    <SettingsSection title={t("settings.codeFont")}>
      <SettingsCard>
        <SettingsInput
          key={saved}
          label={t("settings.fontFamily")}
          hint={t("settings.fontFamilyHint")}
          error={valid ? null : t("settings.fontFamilyInvalid")}
          initialValue={saved}
          placeholder={'"JetBrains Mono", monospace'}
          disabled={settings.saving}
          onChangeText={setDraft}
        />
        <SettingsAction
          label={t("settings.applyFont")}
          actionLabel={t("settings.apply")}
          disabled={settings.saving || !valid || draft.trim() === saved}
          onPress={apply}
        />
        <SettingsSelect
          label={t("settings.textSize")}
          hint={t("settings.textSizeHint")}
          value={settings.values.textSize}
          options={TEXT_SIZES.map((size) => ({ value: size, label: textSizeLabels[size]() }))}
          disabled={settings.saving}
          onValueChange={change("textSize", TEXT_SIZES)}
        />
        <SettingsSelect
          label={t("settings.lineSpacing")}
          value={settings.values.lineSpacing}
          options={LINE_SPACINGS.map((spacing) => ({ value: spacing, label: lineSpacingLabels[spacing]() }))}
          disabled={settings.saving}
          onValueChange={change("lineSpacing", LINE_SPACINGS)}
        />
        <SettingsRow label={t("settings.codeFontPreview")}>
          <Text {...cmonoTextEscape} style={preview}>{"src/app.ts  +12 −3\n$ npm test -- --watch=false"}</Text>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

/** 0.11.0：代码与 diff（diffWrap 开关 + commandColors 行头命令着色）。 */
function DiffControls({ settings }: { settings: ReadySettings }) {
  const changeWrap = (value: boolean) => {
    if (value === (settings.values.diffWrap === "on")) return;
    void settings.save({ ...settings.values, diffWrap: value ? "on" : "off" }, settings.revision);
  };
  const changeCommandColors = (value: string) => {
    const parsed = commandColorsSchema.safeParse(value);
    if (!parsed.success || parsed.data === settings.values.commandColors) return;
    void settings.save({ ...settings.values, commandColors: parsed.data }, settings.revision);
  };
  return (
    <SettingsSection title={t("settings.codeAndDiffs")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.commandColors")}
          hint={t("settings.commandColorsHint")}
          value={settings.values.commandColors}
          options={[
            { value: "expanded", get label() { return t("settings.whenOpen"); } },
            { value: "always", get label() { return t("settings.alwaysColored"); } },
          ]}
          disabled={settings.saving}
          onValueChange={changeCommandColors}
        />
        <SettingsSwitch label={t("settings.wrapDiffLines")} hint={t("settings.wrapDiffHint")} value={settings.values.diffWrap === "on"} disabled={settings.saving} onValueChange={changeWrap} />
      </SettingsCard>
    </SettingsSection>
  );
}

/** 0.11.0：思考行实时跟随（thoughtTailFollow 开关 + thoughtTailLines 尾窗大小；client/activity-details.tsx 消费）。 */
function ThoughtControls({ settings }: { settings: ReadySettings }) {
  const saved = settings.values.thoughtTailLines;
  const [draft, setDraft] = useState(String(saved));
  const [shown, setShown] = useState(String(saved));
  // 外部保存（本端或其他设备）后，草稿跟随存储值重置。
  if (shown !== String(saved)) {
    setShown(String(saved));
    setDraft(String(saved));
  }
  const parsed = /^\d+$/.test(draft.trim()) ? Number.parseInt(draft.trim(), 10) : null;
  const valid = parsed !== null && parsed >= 5 && parsed <= 500;
  const changeFollow = (value: boolean) => {
    if (value === settings.values.thoughtTailFollow) return;
    void settings.save({ ...settings.values, thoughtTailFollow: value }, settings.revision);
  };
  const applyLines = () => {
    if (!valid || parsed === saved) return;
    void settings.save({ ...settings.values, thoughtTailLines: parsed }, settings.revision);
  };
  const error = valid || !draft.trim() ? null : t("settings.tailLinesInvalid");
  return (
    <SettingsSection title={t("settings.thoughtRows")}>
      <SettingsCard>
        <SettingsSwitch label={t("settings.tailFollow")} hint={t("settings.tailFollowHint")} value={settings.values.thoughtTailFollow} disabled={settings.saving} onValueChange={changeFollow} />
        <SettingsInput
          key={String(saved)}
          label={t("settings.tailLines")}
          hint={t("settings.tailLinesHint")}
          error={error}
          initialValue={String(saved)}
          disabled={settings.saving || !settings.values.thoughtTailFollow}
          onChangeText={setDraft}
        />
        <SettingsAction
          label={t("settings.applyTailLines")}
          actionLabel={t("settings.apply")}
          disabled={settings.saving || !settings.values.thoughtTailFollow || !valid || parsed === saved}
          onPress={applyLines}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function DisplaySettings({ theme, actions }: PluginSurfaceProps & { actions: SettingsActions }) {
  const settings = useSettings(activitySettings);
  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme.colors.foreground]);
  if (settings.status === "loading") return <Text style={textStyle}>{t("settings.readingSettings")}</Text>;
  if (settings.status === "error") {
    return (
      <SettingsSection title={t("settings.vividActivity")}>
        <Text style={textStyle}>{settings.error}</Text>
        <SettingsAction label={t("ui.settings")} actionLabel={t("ui.readAgain")} onPress={settings.reload} />
      </SettingsSection>
    );
  }
  if (settings.status === "invalid") {
    return (
      <SettingsSection title={t("settings.vividActivity")}>
        <Text style={textStyle}>{settings.error}</Text>
        <SettingsAction label={t("settings.savedSettings")} actionLabel={t("settings.restoreDefaults")} onPress={settings.reset} />
        <SettingsAction label={t("settings.savedSettings")} actionLabel={t("ui.readAgain")} onPress={settings.reload} />
      </SettingsSection>
    );
  }
  return (
    <>
      <TakeoverControls settings={settings} actions={actions} />
      <FoldControls settings={settings} actions={actions} />
      <ThoughtControls settings={settings} />
      <PaletteControls settings={settings} theme={theme} actions={actions} />
      <FontControls settings={settings} theme={theme} />
      <DiffControls settings={settings} />
      <ExpansionControls settings={settings} />
    </>
  );
}


export function ActivitySettings(props: PluginSurfaceProps & { actions: SettingsActions; paletteFor: (theme: PluginSurfaceProps["theme"], mode: PaletteMode) => ActivityPalette }) {
  return <><LanguageSettings /><PreviewSection theme={props.theme} paletteFor={props.paletteFor} /><DisplaySettings {...props} /></>;
}

/** 0.11.0：设置顶部的实时预览卡（client/preview-card.tsx）。 */
function PreviewSection({ theme, paletteFor }: { theme: PluginSurfaceProps["theme"]; paletteFor: (theme: PluginSurfaceProps["theme"], mode: PaletteMode) => ActivityPalette }) {
  if (!theme) return null;
  return (
    <SettingsSection title={t("settings.preview")}>
      <SettingsCard>
        <PreviewCard theme={theme} paletteFor={paletteFor} />
      </SettingsCard>
    </SettingsSection>
  );
}
