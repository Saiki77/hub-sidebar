import {
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
  Notice,
  App,
  WorkspaceLeaf,
  View,
  TFile,
} from "obsidian";

// --- settings ---------------------------------------------------------------

export interface HubSidebarSettings {
  outlineTiers: number;
  showSwitcher: boolean;
  showLabels: boolean;
  hideTabBar: boolean;
  showVerticalDivider: boolean;
  graphAspect: number; // width / height of the framed graph box (1 = square)
}

export const DEFAULT_SETTINGS: HubSidebarSettings = {
  outlineTiers: 2,
  showSwitcher: true,
  showLabels: true,
  hideTabBar: true,
  showVerticalDivider: false,
  graphAspect: 1,
};

// The three views the switcher rotates between. Icons are Lucide names.
export interface SwitchType {
  type: string;
  icon: string;
  label: string;
}

export const SWITCH_TYPES: SwitchType[] = [
  { type: "localgraph", icon: "git-fork", label: "Local graph" },
  { type: "backlink", icon: "arrow-down-left", label: "Incoming links (backlinks)" },
  { type: "outgoing-link", icon: "arrow-up-right", label: "Outgoing links" },
];

export const HOST_TYPES: string[] = SWITCH_TYPES.map((s) => s.type);

// Header text shown above each framed box / the outline (Publish-style labels).
export const VIEW_LABELS: Record<string, string> = {
  localgraph: "Interactive graph",
  backlink: "Incoming links",
  "outgoing-link": "Outgoing links",
  outline: "On this page",
};

// --- narrow types for undocumented-but-stable Obsidian internals ------------

interface InternalPlugin {
  enabled?: boolean;
  enable?: (reloadApp: boolean) => void;
}

interface InternalPlugins {
  getPluginById?: (id: string) => InternalPlugin | undefined;
  plugins?: Record<string, InternalPlugin | undefined>;
}

interface AppWithInternalPlugins extends App {
  internalPlugins?: InternalPlugins;
}

// `View` exposes contentEl/getViewType at runtime; type them narrowly here.
interface ViewWithContent extends View {
  contentEl: HTMLElement;
  getViewType(): string;
}

// `containerEl` exists on a leaf at runtime but is not in the public type defs.
interface LeafWithContainer extends WorkspaceLeaf {
  containerEl: HTMLElement;
}

const BODY_CLASSES = [
  "hub-tiers-1",
  "hub-tiers-2",
  "hub-tiers-3",
  "hub-hide-tabbar",
  "hub-show-divider",
];

// ---------------------------------------------------------------------------

export default class HubSidebarPlugin extends Plugin {
  declare settings: HubSidebarSettings;

  // `injectAll` is bound and reused as a listener; keep a stable reference.
  private boundInjectAll!: () => void;

  async onload() {
    // `loadData()` is typed `Promise<any>`; narrow it to a partial of our
    // settings shape so the merge is type-safe (no `any` leaking through).
    const saved = (await this.loadData()) as Partial<HubSidebarSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.applyBodyClasses();
    this.addSettingTab(new HubSidebarSettingTab(this.app, this));

    // Best-effort: enable the core link plugins so morphing to backlink /
    // outgoing-link works. Wrapped in try/catch because internalPlugins is
    // undocumented and could change; failure here is non-fatal.
    this.enableCore("backlink");
    this.enableCore("outgoing-link");

    this.boundInjectAll = () => this.injectAll();
    this.registerEvent(this.app.workspace.on("layout-change", this.boundInjectAll));
    this.registerEvent(this.app.workspace.on("active-leaf-change", this.boundInjectAll));
    this.app.workspace.onLayoutReady(() => this.injectAll());
  }

  onunload() {
    document.body.classList.remove(...BODY_CLASSES);
    document.body.style.removeProperty("--hub-graph-aspect");
    document.querySelectorAll(".hub-switcher, .hub-label").forEach((el) => el.remove());
  }

  // --- body classes + CSS vars that drive the stylesheet ----------------------
  applyBodyClasses() {
    document.body.classList.remove(...BODY_CLASSES);
    document.body.classList.add("hub-tiers-" + this.settings.outlineTiers);
    if (this.settings.hideTabBar) document.body.classList.add("hub-hide-tabbar");
    if (this.settings.showVerticalDivider) document.body.classList.add("hub-show-divider");
    document.body.style.setProperty("--hub-graph-aspect", String(this.settings.graphAspect));
  }

  enableCore(id: string) {
    try {
      const ip = (this.app as AppWithInternalPlugins).internalPlugins;
      const p =
        ip && (ip.getPluginById ? ip.getPluginById(id) : ip.plugins && ip.plugins[id]);
      if (p && !p.enabled && typeof p.enable === "function") p.enable(false);
    } catch {
      /* non-fatal */
    }
  }

  // --- label + switcher injection --------------------------------------------
  injectAll() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as ViewWithContent | undefined;
      if (!view || typeof view.getViewType !== "function") return;
      if (!this.isInRightSidebar(leaf)) return;
      const type = view.getViewType();
      const container = view.contentEl; // .view-content (the framed box)
      if (!container) return;

      const isHost = HOST_TYPES.indexOf(type) !== -1;
      const isOutline = type === "outline";
      if (!isHost && !isOutline) return;

      // header label above the box / outline
      if (this.settings.showLabels && VIEW_LABELS[type]) {
        this.ensureLabel(container, VIEW_LABELS[type]);
      } else {
        this.removeLabel(container);
      }

      // the Graph / Incoming / Outgoing switcher (host views only)
      if (isHost && this.settings.showSwitcher) {
        this.ensureSwitcher(leaf, container, type);
      } else {
        container.querySelectorAll(".hub-switcher").forEach((el) => el.remove());
      }
    });
  }

  isInRightSidebar(leaf: WorkspaceLeaf): boolean {
    let el: HTMLElement | null = (leaf as LeafWithContainer).containerEl;
    while (el) {
      if (el.classList && el.classList.contains("mod-right-split")) return true;
      el = el.parentElement;
    }
    return false;
  }

  // Inserts/updates a header label as the sibling immediately before the
  // framed `.view-content`, so it renders above the box (Publish-style).
  ensureLabel(container: HTMLElement, text: string) {
    const host = container.parentElement; // .workspace-leaf-content
    if (!host) return;
    let label = host.querySelector<HTMLElement>(":scope > .hub-label");
    if (!label) label = createDiv({ cls: "hub-label" });
    if (label.nextElementSibling !== container) host.insertBefore(label, container);
    if (label.getText() !== text) label.setText(text);
  }

  removeLabel(container: HTMLElement) {
    const host = container.parentElement;
    host?.querySelector(":scope > .hub-label")?.remove();
  }

  ensureSwitcher(leaf: WorkspaceLeaf, container: HTMLElement, activeType: string) {
    let bar = container.querySelector(":scope > .hub-switcher");
    if (!bar) {
      bar = container.createDiv({ cls: "hub-switcher" });
      for (const s of SWITCH_TYPES) {
        const btn = bar.createDiv({
          cls: "hub-switcher-btn",
          attr: { "aria-label": s.label, "data-switch-type": s.type },
        });
        setIcon(btn, s.icon);
        // plain listener: the node is removed when the view is destroyed, so it
        // cleans itself up without accumulating in the plugin's registry.
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          void this.switchLeaf(leaf, s.type);
        });
      }
    }
    bar.querySelectorAll(".hub-switcher-btn").forEach((b) => {
      b.classList.toggle("is-active", b.getAttribute("data-switch-type") === activeType);
    });
  }

  async switchLeaf(leaf: WorkspaceLeaf, type: string) {
    try {
      const file = this.app.workspace.getActiveFile();
      const state =
        type === "localgraph" && file instanceof TFile ? { file: file.path } : {};
      await leaf.setViewState({ type, state, active: true });
      void this.app.workspace.revealLeaf(leaf);
    } catch {
      new Notice(
        'Hub Sidebar: could not switch view. Enable the "Backlinks" and "Outgoing Links" core plugins.',
      );
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyBodyClasses();
    // clear stale labels/switchers, then re-inject per current settings
    document.querySelectorAll(".hub-switcher, .hub-label").forEach((el) => el.remove());
    this.injectAll();
  }
}

export class HubSidebarSettingTab extends PluginSettingTab {
  plugin: HubSidebarPlugin;

  constructor(app: App, plugin: HubSidebarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Outline heading tiers")
      .setDesc(
        'How many heading levels to show in the outline ("On this page"). Counts nesting depth, not literal H1/H2.',
      )
      .addDropdown((d) =>
        d
          .addOption("1", "1 tier")
          .addOption("2", "2 tiers")
          .addOption("3", "3 tiers")
          .setValue(String(this.plugin.settings.outlineTiers))
          .onChange(async (v) => {
            this.plugin.settings.outlineTiers = parseInt(v, 10);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Show graph switcher")
      .setDesc(
        "Show the Graph / Incoming / Outgoing buttons in the top-right of the framed box.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showSwitcher).onChange(async (v) => {
          this.plugin.settings.showSwitcher = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Show section labels")
      .setDesc('The "Interactive graph" / "On this page" headers above each box.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showLabels).onChange(async (v) => {
          this.plugin.settings.showLabels = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Hide sidebar tab bar")
      .setDesc(
        "Hide the row of tab icons above the graph box. Note: this also hides switching to any OTHER tabs sharing that group (calendar, tags, etc.).",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.hideTabBar).onChange(async (v) => {
          this.plugin.settings.hideTabBar = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Show sidebar divider line")
      .setDesc(
        "Show the vertical divider line between the editor and the right sidebar. Off = the borderless Publish look.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showVerticalDivider).onChange(async (v) => {
          this.plugin.settings.showVerticalDivider = v;
          await this.plugin.saveSettings();
        }),
      );

    // --- graph box shape + live preview --------------------------------------
    // Build the preview detached first so the slider's onChange can reference it,
    // then append it BELOW the slider row.
    const previewWrap = createDiv({ cls: "hub-aspect-preview-wrap" });
    previewWrap.createDiv({ cls: "hub-aspect-preview-caption", text: "Preview" });
    const preview = previewWrap.createDiv({ cls: "hub-aspect-preview" });
    preview.createDiv({ cls: "hub-aspect-preview-dot" });
    const applyAspect = (v: number) => preview.style.setProperty("aspect-ratio", String(v));
    applyAspect(this.plugin.settings.graphAspect);

    new Setting(containerEl)
      .setName("Graph box shape")
      .setDesc("Aspect ratio (width ÷ height) of the framed graph box. 1 = square, lower = taller, higher = wider.")
      .addSlider((s) =>
        s
          .setLimits(0.6, 2, 0.05)
          .setValue(this.plugin.settings.graphAspect)
          .onChange(async (v) => {
            this.plugin.settings.graphAspect = v;
            applyAspect(v);
            await this.plugin.saveSettings();
          }),
      );

    containerEl.appendChild(previewWrap);
  }
}
