import {
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
  getIcon,
  getIconIds,
  Notice,
  App,
  WorkspaceLeaf,
  View,
  MarkdownView,
  FuzzySuggestModal,
  FuzzyMatch,
  TFile,
  normalizePath,
  prepareFuzzySearch,
} from "obsidian";

// --- settings ---------------------------------------------------------------

export interface TemplateButton {
  template: string; // vault path to the Templater template (.md)
  icon: string; // icon id (built-in Lucide, or any plugin-registered icon)
  tooltip: string; // hover label / aria-label for the header button
}

export interface HubSidebarSettings {
  outlineTiers: number;
  showSwitcher: boolean;
  showLabels: boolean;
  hideTabBar: boolean;
  showVerticalDivider: boolean;
  graphAspect: number; // width / height of the framed graph box (1 = square)
  graphTopPad: number; // px of space above the framed box
  centerOnScreen: boolean; // shift the editor column to the window center
  sidebarRibbon: boolean; // show a ribbon icon that toggles the right sidebar
  newTabSearch: boolean; // add a vault search field to the empty "New tab" page
  newTabQuote: string; // optional faint quote shown large above the new-tab search
  templateButtons: TemplateButton[]; // header buttons that insert Templater templates
}

export const DEFAULT_SETTINGS: HubSidebarSettings = {
  outlineTiers: 2,
  showSwitcher: true,
  showLabels: true,
  hideTabBar: true,
  showVerticalDivider: false,
  graphAspect: 1,
  graphTopPad: 16,
  centerOnScreen: false,
  sidebarRibbon: false,
  newTabSearch: true,
  newTabQuote: "",
  templateButtons: [],
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

// Community-plugin registry (undocumented but stable; not in the public App type).
interface CommunityPlugins {
  getPlugin?: (id: string) => unknown;
}
interface AppWithPlugins extends App {
  plugins?: CommunityPlugins;
}
// The Templater plugin instance — only the bits we touch (its API is internal).
interface TemplaterPlugin {
  templater?: { append_template_to_active_file?: (file: TFile) => Promise<void> };
  settings?: { templates_folder?: string };
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
  "hub-center-screen",
];

// ---------------------------------------------------------------------------

export default class HubSidebarPlugin extends Plugin {
  declare settings: HubSidebarSettings;

  // `injectAll` is bound and reused as a listener; keep a stable reference.
  private boundInjectAll!: () => void;

  // Re-applies the Templater header buttons; registered on several workspace events.
  private boundApplyTemplateButtons!: () => void;

  // `recompute` is registered on several workspace/window events; keep a stable
  // reference so the registrations all share one rAF-debounced implementation.
  private boundRecompute!: () => void;

  // Pending requestAnimationFrame handle for the debounced offset recompute.
  private centerRaf: number | null = null;

  // The optional status-bar "toggle right sidebar" button, added/removed live as
  // the `sidebarRibbon` setting flips. Status bar, NOT ribbon, because Minimal's
  // "Hide ribbon" option hides ribbon icons entirely.
  private statusEl: HTMLElement | null = null;

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

    // Feature 2: a command (palette + assignable hotkey) that toggles the right
    // sidebar. Always registered; the optional ribbon is gated by a setting.
    this.addCommand({
      id: "toggle-right-sidebar",
      name: "Toggle the right sidebar",
      callback: () => this.toggleRightSidebar(),
    });
    this.syncToggleButton();

    this.boundInjectAll = () => this.injectAll();
    this.boundRecompute = () => this.scheduleCenterOffset();
    this.registerEvent(this.app.workspace.on("layout-change", this.boundInjectAll));
    this.registerEvent(this.app.workspace.on("active-leaf-change", this.boundInjectAll));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => this.focusNewTabSearch(leaf)),
    );
    // Templater header buttons: (re)apply as views open / change / reload.
    this.boundApplyTemplateButtons = () => this.applyTemplateButtons();
    this.registerEvent(this.app.workspace.on("layout-change", this.boundApplyTemplateButtons));
    this.registerEvent(this.app.workspace.on("active-leaf-change", this.boundApplyTemplateButtons));
    this.registerEvent(this.app.workspace.on("file-open", this.boundApplyTemplateButtons));

    // Feature 1: keep --hub-center-offset fresh. updateCenterOffset() early-
    // returns when the feature is off, so these listeners cost nothing extra in
    // the default (disabled) state.
    this.registerEvent(this.app.workspace.on("resize", this.boundRecompute));
    this.registerEvent(this.app.workspace.on("layout-change", this.boundRecompute));
    this.registerDomEvent(window, "resize", this.boundRecompute);

    this.app.workspace.onLayoutReady(() => {
      this.injectAll();
      this.applyTemplateButtons();
      this.updateCenterOffset();
    });
  }

  onunload() {
    if (this.centerRaf !== null) {
      window.cancelAnimationFrame(this.centerRaf);
      this.centerRaf = null;
    }
    activeDocument.body.classList.remove(...BODY_CLASSES);
    activeDocument.body.style.removeProperty("--hub-graph-aspect");
    activeDocument.body.style.removeProperty("--hub-center-offset");
    if (this.statusEl) {
      this.statusEl.remove();
      this.statusEl = null;
    }
    activeDocument.querySelectorAll(".hub-switcher, .hub-label").forEach((el) => el.remove());
    activeDocument
      .querySelectorAll(".hub-newtab-quote, .hub-newtab-search")
      .forEach((el) => el.remove());
    activeDocument
      .querySelectorAll(".hub-newtab-active")
      .forEach((el) => el.classList.remove("hub-newtab-active"));
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      leaf.view.containerEl.querySelectorAll("[data-hub-tpl-btn]").forEach((el) => el.remove());
    });
    this.clearTabGroupMarkers();
  }

  // --- body classes + CSS vars that drive the stylesheet ----------------------
  applyBodyClasses() {
    activeDocument.body.classList.remove(...BODY_CLASSES);
    activeDocument.body.classList.add("hub-tiers-" + this.settings.outlineTiers);
    if (this.settings.hideTabBar) activeDocument.body.classList.add("hub-hide-tabbar");
    if (this.settings.showVerticalDivider) activeDocument.body.classList.add("hub-show-divider");
    if (this.settings.centerOnScreen) activeDocument.body.classList.add("hub-center-screen");
    activeDocument.body.style.setProperty("--hub-graph-aspect", String(this.settings.graphAspect));
    activeDocument.body.style.setProperty("--hub-top-pad", this.settings.graphTopPad + "px");
    // The class just turned on/off; make sure the offset + box size are current.
    this.applyGraphSizeAll();
    this.updateCenterOffset();
  }

  // --- Feature 1: center-on-screen offset ------------------------------------
  // Debounce bursts of resize events (e.g. dragging the sidebar handle) into a
  // single layout read + var write per animation frame.
  scheduleCenterOffset() {
    if (this.centerRaf !== null) return;
    this.centerRaf = window.requestAnimationFrame(() => {
      this.centerRaf = null;
      this.applyGraphSizeAll();
      this.updateCenterOffset();
    });
  }

  // offset = (rightSidebarWidth - leftSidebarWidth) / 2, clamped to the pane's
  // free half-width so the column can never be pushed out of its pane. Written
  // to --hub-center-offset on <body>; only the transformed layer repaints, so
  // CM6 is never asked to remeasure (caret/click geometry stays correct).
  updateCenterOffset() {
    // When the feature is off (the default) the CSS ignores the var, so the
    // per-event layout reads below would be pure waste. Clear any stale offset
    // once, then bail before forcing a reflow.
    if (!this.settings.centerOnScreen) {
      this.writeCenterOffset(0);
      return;
    }

    const ws = this.app.workspace;
    const leftCollapsed = ws.leftSplit?.collapsed ?? true;
    const rightCollapsed = ws.rightSplit?.collapsed ?? true;

    const leftEl = activeDocument.querySelector<HTMLElement>(
      ".workspace-split.mod-left-split",
    );
    const rightEl = activeDocument.querySelector<HTMLElement>(
      ".workspace-split.mod-right-split",
    );
    const leftW = !leftCollapsed && leftEl ? leftEl.clientWidth : 0;
    const rightW = !rightCollapsed && rightEl ? rightEl.clientWidth : 0;

    let offset = (rightW - leftW) / 2;

    // Clamp to the root pane's free half-width using the live readable column.
    const root = activeDocument.querySelector<HTMLElement>(".workspace-split.mod-root");
    const paneW = root ? root.clientWidth : 0;
    const sizer = root?.querySelector<HTMLElement>(
      ".cm-sizer, .markdown-preview-sizer",
    );
    const colW = sizer ? sizer.getBoundingClientRect().width : 0;
    const freeHalf = Math.max(0, (paneW - colW) / 2);
    offset = Math.max(-freeHalf, Math.min(freeHalf, offset));

    this.writeCenterOffset(offset);
  }

  // Single writer for --hub-center-offset; rounds to a whole px and skips the
  // DOM write when unchanged. Centralizing it also keeps the value off a string
  // literal at the call site (the value is always derived, never a constant).
  writeCenterOffset(offset: number) {
    const px = Math.round(offset) + "px";
    if (activeDocument.body.style.getPropertyValue("--hub-center-offset") !== px) {
      activeDocument.body.style.setProperty("--hub-center-offset", px);
    }
  }

  // --- Feature 2: right-sidebar toggle + optional ribbon ----------------------
  toggleRightSidebar() {
    const right = this.app.workspace.rightSplit;
    if (!right) return;
    right.toggle();
    // The pane width just changed; re-center immediately if Feature 1 is on.
    this.updateCenterOffset();
  }

  // Adds or removes a status-bar toggle button to match the `sidebarRibbon`
  // setting. Uses the status bar (not addRibbonIcon) so it stays visible even
  // when Minimal's "Hide ribbon" option is on.
  syncToggleButton() {
    if (this.settings.sidebarRibbon && !this.statusEl) {
      const el = this.addStatusBarItem();
      el.addClass("hub-sidebar-toggle", "mod-clickable");
      setIcon(el, "panel-right");
      el.setAttribute("aria-label", "Toggle right sidebar");
      el.addEventListener("click", () => this.toggleRightSidebar());
      this.statusEl = el;
    } else if (!this.settings.sidebarRibbon && this.statusEl) {
      this.statusEl.remove();
      this.statusEl = null;
    }
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
    // Reset the tab-group markers; re-applied below. They let the stylesheet hide
    // a group's tab bar without a :has() parent selector.
    this.clearTabGroupMarkers();

    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as ViewWithContent | undefined;
      if (!view || typeof view.getViewType !== "function") return;
      const type = view.getViewType();
      const container = view.contentEl; // .view-content (the framed box)
      if (!container) return;

      // New-tab ("empty") views live in the main area, not the right sidebar, so
      // handle the optional search field before the sidebar filter below.
      if (type === "empty") {
        if (this.settings.newTabSearch || this.settings.newTabQuote.trim()) {
          this.ensureNewTabContent(container, leaf);
        } else {
          this.removeNewTabContent(container);
        }
        return;
      }

      if (!this.isInRightSidebar(leaf)) return;

      const isHost = HOST_TYPES.indexOf(type) !== -1;
      const isOutline = type === "outline";
      if (!isHost && !isOutline) return;

      // Mark the enclosing tab group so the stylesheet can hide its tab bar
      // (outline: always; host views: when "Hide sidebar tab bar" is on).
      const tabs = (leaf as LeafWithContainer).containerEl.closest(".workspace-tabs");
      if (tabs) tabs.classList.add(isHost ? "hub-tabs-host" : "hub-tabs-outline");

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

      // explicit height for the graph box (the local graph only)
      if (type === "localgraph") this.applyGraphSize(container);
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

  // Removes the .hub-tabs-host / .hub-tabs-outline markers from every tab group.
  // injectAll() re-adds them for the current hub panes; onunload() leaves none.
  clearTabGroupMarkers() {
    activeDocument
      .querySelectorAll(".workspace-tabs.hub-tabs-host, .workspace-tabs.hub-tabs-outline")
      .forEach((el) => el.classList.remove("hub-tabs-host", "hub-tabs-outline"));
  }

  // --- new-tab search field ---------------------------------------------------
  // Injects a vault-search input into the empty "New tab" page. Enter runs the
  // core global (full-text) search for the query, complementing the page's own
  // "Go to file" (quick switcher) action.
  ensureNewTabContent(container: HTMLElement, leaf: WorkspaceLeaf) {
    // Idempotent across re-injection: check the whole view, since the content may
    // sit in .empty-state-container, .empty-state, or (fallback) the container.
    if (container.querySelector(".hub-newtab-quote, .hub-newtab-search")) return;
    const host =
      container.querySelector<HTMLElement>(".empty-state-container") ??
      container.querySelector<HTMLElement>(".empty-state") ??
      container;

    if (this.settings.newTabSearch) this.buildNewTabSearch(host, leaf);

    // The quote sits above the search box — prepended last so it lands first.
    const quote = this.settings.newTabQuote.trim();
    if (quote) host.prepend(createDiv({ cls: "hub-newtab-quote", text: quote }));
  }

  // An embedded fuzzy finder: an always-present input that shows note results only
  // once you type. While results are shown, the page's action links are hidden
  // (host gets .hub-newtab-active) so the expanding box replaces them.
  buildNewTabSearch(host: HTMLElement, leaf: WorkspaceLeaf) {
    host.removeClass("hub-newtab-active"); // fresh build = not searching yet
    const box = createDiv({ cls: "hub-newtab-search" });
    const row = box.createDiv({ cls: "hub-newtab-search-row" });
    setIcon(row.createSpan({ cls: "hub-newtab-search-icon" }), "search");
    const input = row.createEl("input", {
      cls: "hub-newtab-search-input",
      attr: {
        type: "text",
        placeholder: "Search your notes…",
        "aria-label": "Search your notes",
        spellcheck: "false",
      },
    });
    const list = box.createDiv({ cls: "hub-newtab-results" });

    let matches: TFile[] = [];
    let selected = 0;

    const open = (file: TFile) => void leaf.openFile(file);

    const updateSelection = () => {
      const items = list.querySelectorAll(".hub-newtab-result");
      items.forEach((el, i) => el.classList.toggle("is-selected", i === selected));
      items[selected]?.scrollIntoView({ block: "nearest" });
    };

    const render = () => {
      list.empty();
      if (!input.value.trim()) {
        host.removeClass("hub-newtab-active");
        return;
      }
      host.addClass("hub-newtab-active");
      if (!matches.length) {
        list.createDiv({ cls: "hub-newtab-result is-empty", text: "No notes found" });
        return;
      }
      matches.forEach((file, i) => {
        const item = list.createDiv({
          cls: "hub-newtab-result" + (i === selected ? " is-selected" : ""),
          text: file.path.replace(/\.md$/, ""),
          attr: { role: "option" },
        });
        // mousedown (not click) so the input keeps focus until we open the file.
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          open(file);
        });
        item.addEventListener("mouseenter", () => {
          selected = i;
          updateSelection();
        });
      });
    };

    const search = () => {
      const q = input.value.trim();
      selected = 0;
      if (!q) {
        matches = [];
        render();
        return;
      }
      const fuzzy = prepareFuzzySearch(q);
      const scored: { file: TFile; score: number }[] = [];
      for (const f of this.app.vault.getMarkdownFiles()) {
        const r = fuzzy(f.path);
        if (r) scored.push({ file: f, score: r.score });
      }
      scored.sort((a, b) => b.score - a.score);
      matches = scored.slice(0, 12).map((s) => s.file);
      render();
    };

    input.addEventListener("input", search);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (matches.length) {
          selected = (selected + 1) % matches.length;
          updateSelection();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (matches.length) {
          selected = (selected - 1 + matches.length) % matches.length;
          updateSelection();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (matches[selected]) open(matches[selected]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (input.value) {
          input.value = "";
          search();
        } else {
          input.blur();
        }
      }
    });

    host.prepend(box);
  }

  removeNewTabContent(container: HTMLElement) {
    container.querySelectorAll(".hub-newtab-quote, .hub-newtab-search").forEach((el) => el.remove());
    container
      .querySelectorAll(".hub-newtab-active")
      .forEach((el) => el.classList.remove("hub-newtab-active"));
  }

  // Focus the embedded search input when an empty tab becomes active, so opening a
  // new tab lets you type immediately. Best-effort; no-op if absent.
  focusNewTabSearch(leaf: WorkspaceLeaf | null) {
    if (!leaf || !this.settings.newTabSearch) return;
    const view = leaf.view as ViewWithContent | undefined;
    if (!view || typeof view.getViewType !== "function" || view.getViewType() !== "empty") return;
    const input = view.contentEl.querySelector<HTMLInputElement>(".hub-newtab-search-input");
    if (input) window.setTimeout(() => input.focus(), 0);
  }

  // --- Templater template buttons ---------------------------------------------
  // Templater's API is internal/undocumented, so resolve + guard defensively.
  private templater(): TemplaterPlugin | undefined {
    const tp = (this.app as AppWithPlugins).plugins?.getPlugin?.("templater-obsidian");
    return tp as TemplaterPlugin | undefined;
  }

  templaterAvailable(): boolean {
    return typeof this.templater()?.templater?.append_template_to_active_file === "function";
  }

  // Markdown files usable as templates: Templater's configured folder, else the
  // whole vault (mirrors Templater's own enumeration).
  templateFiles(): TFile[] {
    const folder = (this.templater()?.settings?.templates_folder ?? "").trim();
    const all = this.app.vault.getMarkdownFiles();
    if (!folder) return all;
    const root = normalizePath(folder);
    return all.filter((f) => f.path === root || f.path.startsWith(root + "/"));
  }

  // (Re)apply the configured buttons to every open markdown view's header.
  applyTemplateButtons() {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      if (leaf.view instanceof MarkdownView) this.addButtonsToView(leaf.view);
    });
  }

  addButtonsToView(view: MarkdownView) {
    // addAction does not dedupe, so purge our previous buttons before re-adding.
    view.containerEl.querySelectorAll("[data-hub-tpl-btn]").forEach((el) => el.remove());
    if (!this.templaterAvailable()) return; // Templater absent: show no buttons
    for (const b of this.settings.templateButtons) {
      const path = b.template.trim();
      if (!path) continue;
      const icon = getIcon(b.icon) ? b.icon : "file-plus";
      const el = view.addAction(icon, b.tooltip || "Insert template", () => {
        void this.insertTemplate(path, view);
      });
      el.setAttribute("data-hub-tpl-btn", "1");
    }
  }

  async insertTemplate(path: string, view: MarkdownView) {
    const engine = this.templater()?.templater;
    const append = engine?.append_template_to_active_file;
    if (typeof append !== "function") {
      new Notice("Templater is not installed or enabled.");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      new Notice("Template not found: " + path);
      return;
    }
    // Templater targets the workspace-active file, so make the note whose button
    // was clicked active first — otherwise it could write to a different pane.
    this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
    try {
      await append.call(engine, file);
    } catch (e) {
      console.warn("[hub-sidebar] template insert failed", e);
      new Notice("Hub Sidebar: template insert failed (see console).");
    }
  }

  // --- graph box sizing -------------------------------------------------------
  // Minimal forces the graph view to grow and fill the pane height, which beats
  // CSS aspect-ratio. So set an explicit pixel height (= box width / chosen
  // ratio) inline, which the theme can't override and which updates live.
  applyGraphSize(container: HTMLElement) {
    const w = container.clientWidth;
    if (w <= 0) return; // hidden/collapsed pane — re-sized when it becomes visible
    const aspect = this.settings.graphAspect || 1;
    container.style.height = Math.round(w / aspect) + "px";
  }

  applyGraphSizeAll() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as ViewWithContent | undefined;
      if (!view || typeof view.getViewType !== "function") return;
      if (view.getViewType() !== "localgraph") return;
      if (!this.isInRightSidebar(leaf)) return;
      if (view.contentEl) this.applyGraphSize(view.contentEl);
    });
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
    try {
      await this.saveData(this.settings);
    } catch (e) {
      console.warn("[hub-sidebar] failed to save settings", e);
      new Notice("Hub Sidebar: could not save settings (see console).");
    }
    this.applyBodyClasses();
    this.syncToggleButton();
    // clear stale labels/switchers, then re-inject per current settings
    activeDocument
      .querySelectorAll(".hub-switcher, .hub-label, .hub-newtab-quote, .hub-newtab-search")
      .forEach((el) => el.remove());
    this.injectAll();
    this.applyTemplateButtons();
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

    new Setting(containerEl)
      .setName("Graph box top padding")
      .setDesc("Space above the framed box — how far down it sits, in pixels.")
      .addSlider((s) =>
        s
          .setLimits(0, 48, 2)
          .setValue(this.plugin.settings.graphTopPad)
          .onChange(async (v) => {
            this.plugin.settings.graphTopPad = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Center note on screen")
      .setDesc(
        "Shift the editor column so it stays centered in the window, compensating for the open sidebars. Best for a single editor pane; side-by-side splits and the line-number gutter are best-effort.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.centerOnScreen).onChange(async (v) => {
          this.plugin.settings.centerOnScreen = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Right sidebar toggle button")
      .setDesc(
        'Add a status-bar button that toggles the right sidebar. (It lives in the status bar, not the ribbon, since Minimal hides the ribbon.) The "Toggle the right sidebar" command — assignable to a hotkey — is always available regardless of this setting.',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.sidebarRibbon).onChange(async (v) => {
          this.plugin.settings.sidebarRibbon = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("New-tab search field")
      .setDesc(
        'Add a search box to the empty "New tab" page. Press Enter to run a full-text search of your vault (complements the page\'s built-in "Go to file" quick switcher).',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.newTabSearch).onChange(async (v) => {
          this.plugin.settings.newTabSearch = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("New-tab quote")
      .setDesc(
        "A line shown large and faint above the new-tab search field. Leave empty for none.",
      )
      .addText((t) =>
        t
          .setPlaceholder("Don't delegate understanding")
          .setValue(this.plugin.settings.newTabQuote)
          .onChange(async (v) => {
            this.plugin.settings.newTabQuote = v;
            await this.plugin.saveSettings();
          }),
      );

    this.displayTemplateButtons(containerEl);
  }

  displayTemplateButtons(containerEl: HTMLElement) {
    new Setting(containerEl).setName("Templater template buttons").setHeading();
    // Render into its own container so add/remove/pick can refresh just this list
    // (without re-running the whole, now-deprecated, settings-tab display()).
    const list = containerEl.createDiv();
    this.renderTemplateButtons(list);
  }

  renderTemplateButtons(list: HTMLElement) {
    list.empty();
    new Setting(list)
      .setDesc(
        this.plugin.templaterAvailable()
          ? "Each button shows in a note's header (next to the reading-view toggle) and inserts its template at the cursor. Pick a template, an icon, and a tooltip."
          : "Install and enable the Templater community plugin to use these buttons.",
      )
      .addButton((b) =>
        b
          .setButtonText("Add button")
          .setCta()
          .onClick(async () => {
            this.plugin.settings.templateButtons.push({
              template: "",
              icon: "file-plus",
              tooltip: "",
            });
            await this.plugin.saveSettings();
            this.renderTemplateButtons(list);
          }),
      );

    this.plugin.settings.templateButtons.forEach((btn, i) => {
      const file = btn.template
        ? this.app.vault.getAbstractFileByPath(normalizePath(btn.template))
        : null;
      const tplLabel = file ? file.name : btn.template || "Choose template…";
      const row = new Setting(list).setName("Button " + (i + 1));
      row.addButton((b) =>
        b
          .setIcon(getIcon(btn.icon) ? btn.icon : "file-plus")
          .setTooltip("Choose icon")
          .onClick(() =>
            new IconPickerModal(this.app, async (id) => {
              this.plugin.settings.templateButtons[i].icon = id;
              await this.plugin.saveSettings();
              this.renderTemplateButtons(list);
            }).open(),
          ),
      );
      row.addButton((b) =>
        b
          .setButtonText(tplLabel)
          .setTooltip("Choose template")
          .onClick(() =>
            new TemplatePickerModal(this.app, this.plugin.templateFiles(), async (f) => {
              this.plugin.settings.templateButtons[i].template = f.path;
              await this.plugin.saveSettings();
              this.renderTemplateButtons(list);
            }).open(),
          ),
      );
      row.addText((t) =>
        t
          .setPlaceholder("Tooltip")
          .setValue(btn.tooltip)
          .onChange(async (v) => {
            this.plugin.settings.templateButtons[i].tooltip = v;
            await this.plugin.saveSettings();
          }),
      );
      row.addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("Remove")
          .onClick(async () => {
            this.plugin.settings.templateButtons.splice(i, 1);
            await this.plugin.saveSettings();
            this.renderTemplateButtons(list);
          }),
      );
    });
  }
}

// Searchable picker over all registered icons (built-in Lucide + plugin-added).
class IconPickerModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private readonly onChoose: (id: string) => void | Promise<void>,
  ) {
    super(app);
    this.setPlaceholder("Search icons…");
  }
  getItems(): string[] {
    return getIconIds();
  }
  getItemText(id: string): string {
    return id;
  }
  renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void {
    el.addClass("hub-icon-suggestion");
    const ic = el.createSpan({ cls: "hub-icon-suggestion-icon" });
    setIcon(ic, match.item);
    el.createSpan({ text: match.item });
  }
  onChooseItem(id: string): void {
    void this.onChoose(id);
  }
}

// Searchable picker over the candidate template files.
class TemplatePickerModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly files: TFile[],
    private readonly onChoose: (file: TFile) => void | Promise<void>,
  ) {
    super(app);
    this.setPlaceholder("Search templates…");
  }
  getItems(): TFile[] {
    return this.files;
  }
  getItemText(file: TFile): string {
    return file.path;
  }
  onChooseItem(file: TFile): void {
    void this.onChoose(file);
  }
}
