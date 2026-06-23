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
}

export const DEFAULT_SETTINGS: HubSidebarSettings = {
  outlineTiers: 2,
  showSwitcher: true,
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
    this.applyTierClass();
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
    document.body.classList.remove("hub-tiers-1", "hub-tiers-2", "hub-tiers-3");
    document.querySelectorAll(".hub-switcher").forEach((el) => el.remove());
  }

  // --- outline tier limiting (driven by a body class; CSS does the hiding) ---
  applyTierClass() {
    document.body.classList.remove("hub-tiers-1", "hub-tiers-2", "hub-tiers-3");
    document.body.classList.add("hub-tiers-" + this.settings.outlineTiers);
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

  // --- switcher injection ----------------------------------------------------
  injectAll() {
    if (!this.settings.showSwitcher) {
      document.querySelectorAll(".hub-switcher").forEach((el) => el.remove());
      return;
    }
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as ViewWithContent | undefined;
      if (!view || typeof view.getViewType !== "function") return;
      const type = view.getViewType();
      if (HOST_TYPES.indexOf(type) === -1) return;
      if (!this.isInRightSidebar(leaf)) return;
      const container = view.contentEl; // .view-content (the framed box)
      if (!container) return;
      this.ensureSwitcher(leaf, container, type);
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
    this.applyTierClass();
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
        'How many heading levels to show in the outline ("ON THIS PAGE"). Counts nesting depth, not literal H1/H2.',
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
        "Show the Graph / Incoming / Outgoing buttons in the top-right of the framed graph box.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showSwitcher).onChange(async (v) => {
          this.plugin.settings.showSwitcher = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
