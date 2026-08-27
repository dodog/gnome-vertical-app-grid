import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Atk from 'gi://Atk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';

import {
    gettext as _
} from 'resource:///org/gnome/shell/extensions/extension.js';
import {
    SIDE_CONTROLS_ANIMATION_TIME
} from 'resource:///org/gnome/shell/ui/overviewControls.js';

import {
    getCategoryOrder,
    getCategoryContext,
    getAppCategory,
    setAppCategory,
    setCategoryOrder,
    getCategoryOrderMap,
    getCategoryIconMap
} from './categories.js';
import {
    VerticalScrollView
} from './scrollView.js';
import {
    VerticalLayout
} from './layout.js';

// Main vertical app grid widget and helpers for GNOME overview app display.
const CATEGORY_ICONS = {
    _favorites: 'starred-symbolic',
    Other: 'applications-other-symbolic',
    Development: 'utilities-terminal-symbolic',
    Office: 'x-office-document-symbolic',
    Network: 'network-wired-symbolic',
    AudioVideo: 'multimedia-symbolic',
    Audio: 'audio-x-generic-symbolic',
    Video: 'video-x-generic-symbolic',
    Graphics: 'graphics-symbolic',
    Translation: 'emblem-translate-symbolic',
    WebDevelopment: 'internet-web-browser-symbolic',
    PackageManager: 'package-x-generic-symbolic',
    Ebook: 'accessories-text-editor-symbolic',
    HardwareSettings: 'computer-symbolic',
    Finance: 'wallet-symbolic',
    Backup: 'document-save-symbolic',
    Security: 'security-high-symbolic',
    Chat: 'mail-message-new-symbolic',
    Fonts: 'font-panel-symbolic',
    Education: 'accessories-calculator-symbolic',
    Game: 'gamepad-symbolic',
    Utility: 'applications-utilities-symbolic',
    Accessories: 'applications-accessories-symbolic',
    System: 'computer-symbolic',
    Settings: 'emblem-system-symbolic'
};

// Icon opacity values for category-nav states.
const ICON_OPACITY_DEFAULT = 140;
const ICON_OPACITY_HOVER = 217;
const ICON_OPACITY_ACTIVE = 255;

// Fixed nav width; labels fade in/out on hover.
const NAV_WIDTH = 220;
const NAV_TRANSITION_DURATION = 350;

// Nav button height expands on hover for a looser layout.
const NAV_ITEM_HEIGHT_COLLAPSED = 30;
const NAV_ITEM_HEIGHT_EXPANDED = 35;

function easeOutCubic(t) {
    return (--t) * t * t + 1;
}

export const VerticalAppDisplay = GObject.registerClass({
    GTypeName: 'Vertigrid_VerticalAppDisplay'
}, class VerticalAppDisplay extends St.Widget {
        // Main custom app grid widget shown in the GNOME overview.
        constructor(settings) {
            super({
                layout_manager: new Clutter.BinLayout(),
                can_focus: true,
                reactive: true,
                accessible_role: Atk.Role.LIST
            });

            this._settings = settings;
            this._laters = global.compositor.get_laters();

            this._favoritesLabel = this._createSectionHeader(_('Favorites'));

            this._favoritesView = new St.Viewport({
                layout_manager: new VerticalLayout(settings),
                style: 'overflow: hidden;'
            });

            this._mainLabel = this._createSectionHeader(_('All Apps'));

            this._mainView = new St.Viewport({
                layout_manager: new VerticalLayout(settings),
                style: 'overflow: hidden;'
            });

            this._scrollView = new VerticalScrollView(settings);

            this._scrollView.add_child(this._favoritesLabel);
            this._scrollView.add_child(this._favoritesView);
            this._scrollView.add_child(this._mainLabel);
            this._scrollView.add_child(this._mainView);

            this._navBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: false,
                y_expand: false,
                y_align: Clutter.ActorAlign.CENTER,
                reactive: true,
                style_class: 'category-nav-box',
                style: `margin-right: 8px; padding: 8px 0 8px 8px; width: ${NAV_WIDTH}px; overflow: hidden;`
            });

            // Labels start hidden and only shown on hover by default, see
            // _setNavCollapsed() - unless the user has enabled "always show
            // category navigation", in which case start already expanded
            // to avoid an initial collapsed-then-expand flash on first
            // display.
            this._navAlwaysVisible = this._settings.get_boolean('always-show-category-nav');
            this._navCollapsed = !this._navAlwaysVisible;

            this._mainBox = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                y_expand: true
            });

            this._mainBox.add_child(this._navBox);
            this._mainBox.add_child(this._scrollView);
            this.add_child(this._mainBox);

            this._navItems = [];
            this._categoryOrder = [];
            this._navAnim = null;
            this._bottomSpacer = null;

            this._appSystem = Shell.AppSystem.get_default();
            this._appUsage = Shell.AppUsage.get_default();
            this._appFavorites = AppFavorites.getAppFavorites();
            this._parentalControls = ParentalControlsManager.getDefault();
            this._overview = Main.overview;

            this._connectSignals();
            this._addAppIcons();
            this._updateLabelMargins();
        }

        // Connect all app system, overview, and input signals for the app grid.
        _connectSignals() {
            // Redisplay the app grid when an app was installed or removed.
            this._appSystem.connectObject('installed-changed', () => {
                const newIds = this._getInstalledIdsSet();
                if (this._lastInstalledIds && this._setsEqual(this._lastInstalledIds, newIds)) {
                    return;
                }
                this._redisplay();
            }, this);

            // Redisplay when favorites change
            this._appFavorites.connectObject('changed', () => {
                this._redisplay();
            }, this);

            // Redisplay when parental controls change
            this._parentalControls.connectObject('app-filter-changed', () => {
                this._redisplay();
            }, this);

            // Reset scroll when the overview is hidden
            this._overview.connectObject('hidden', () => {
                this._scrollView.scrollTo(0, false);
                this._cancelDrag();
                // Only force the nav back to collapsed if the user hasn't
                // asked for it to always stay expanded.
                if (!this._navAlwaysVisible) {
                    this._setNavCollapsed(true, false);
                }
            }, this);

            // Expand the whole nav (labels + width) while the pointer is
            // anywhere over it, collapse back to icon-only once it leaves.
            // These crossing events bubble to _navBox as an ancestor, so this
            // fires once for the whole container regardless of whether the
            // pointer lands on padding or on a button - independent from
            // each button's own enter/leave used for icon opacity below.
            // Skipped entirely when "always show category navigation" is on,
            // since the nav should just stay expanded regardless of hover.
            this._navBox.connect('enter-event', () => {
                if (this._navAlwaysVisible) return;
                this._setNavCollapsed(false);
            });
            this._navBox.connect('leave-event', () => {
                if (this._navAlwaysVisible) return;
                this._setNavCollapsed(true);
            });

            // Update layout when settings change
            this._settings.connectObject('changed', (_source, key) => {
                switch (key) {
                    case 'app-sorting':
                    case 'favorites-section':
                    case 'favorites-sorting':
                    case 'category-grouping':
                    case 'show-favorites-in-app-grid':
                    case 'category-font-size':
                    case 'custom-categories':
                    case 'clip-app-labels':
                    case 'hidden-apps':
                        this._redisplay();
                        break;

                    case 'icon-spacing':
                        this._updateLabelMargins();
                        break;

                    case 'icon-size':
                        this._updateIconSize();
                        break;

                    case 'always-show-category-nav':
                        this._updateNavAlwaysVisible();
                        break;
                }
            }, this);

            // Clicking empty space in the app grid should hide the overview,
            // same as clicking the background elsewhere.
            this.connect('button-release-event', () => {
                this._overview.hide();
                return Clutter.EVENT_PROPAGATE;
            });

            // Keep the left-nav active-category highlight in sync with
            // whatever section is currently at the top of the scroll view -
            // covers wheel scrolling, keyboard paging, and programmatic
            // scrolls (e.g. clicking a nav button) all through one signal.
            this._scrollValueHandler = this._scrollView.vadjustment.connect('notify::value', () => {
                this._updateActiveCategoryFromScroll();
            });
        }

        _createSectionHeader(text) {
            const row = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                y_expand: false,
                y_align: Clutter.ActorAlign.CENTER
            });

            const label = new St.Label({
                text,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 16px; font-weight: 400; color: white; margin-right: 10px;'
            });

            const line = new St.Widget({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'min-height: 1px; background-gradient-direction: horizontal; background-gradient-start: rgba(255,255,255,0.3); background-gradient-end: rgba(255,255,255,0);'
            });
            line.set_height(1);

            row.add_child(label);
            row.add_child(line);

            return row;
        }

        // Applies (or reverses) the "always show category navigation"
        // setting immediately, without requiring the overview to be
        // reopened. Reuses _setNavCollapsed() so it goes through the same
        // animation/teardown-guard logic as ordinary hover-driven changes.
        _updateNavAlwaysVisible() {
            this._navAlwaysVisible = this._settings.get_boolean('always-show-category-nav');
            this._setNavCollapsed(!this._navAlwaysVisible);
        }

        // translate_coordinates() isn't callable on every actor here -
        // St.Viewport/St.Label instances have been observed to throw
        // "translate_coordinates is not a function" in this Shell/Mutter
        // version, so get_transformed_position() is a required fallback,
        // not just defensive padding.
        _getStagePosition(actor) {
            if (actor.translate_coordinates) {
                return actor.translate_coordinates(global.stage, 0, 0);
            }
            if (actor.get_transformed_position) {
                return actor.get_transformed_position();
            }
            return [0, 0];
        }

        // Computes where in destView's child list a drop at stage
        // coordinates (stageX, stageY) should land, using the same
        // row/column formula VerticalLayout uses to actually place
        // children (col = i % columns, row = floor(i / columns)) run in
        // reverse. This works uniformly whether the pointer is over an
        // icon or over a gap between/after icons.
        _computeGridInsertIndex(destView, stageX, stageY) {
            const children = destView.get_children();
            const [viewX, viewY] = this._getStagePosition(destView);

            const localX = stageX - viewX;
            const localY = stageY - viewY;

            const layout = destView.layout_manager;
            const columns = Math.max(1, layout._columns);
            const spacing = layout._spacing;
            const childSize = layout._getMinChildSize(children);
            const cellSize = childSize + spacing;

            if (cellSize <= 0 || children.length === 0) {
                return children.length;
            }

            const col = Math.min(columns - 1, Math.max(0, Math.floor(localX / cellSize)));
            const row = Math.max(0, Math.floor(localY / cellSize));

            const index = row * columns + col;
            return Math.min(Math.max(index, 0), children.length);
        }

        _getInstalledIdsSet() {
            const ids = new Set();
            this._appSystem.get_installed().forEach(appInfo => {
                try {
                    ids.add(appInfo.get_id());
                } catch {
                    // Skip apps whose id can't be read rather than fail the whole scan.
                }
            });
            return ids;
        }

        _setsEqual(a, b) {
            if (a.size !== b.size) {
                return false;
            }
            for (const id of a) {
                if (!b.has(id)) {
                    return false;
                }
            }
            return true;
        }

        _addAppIcons() {
            const iconSize = this._settings.get_int('icon-size');
            const favSection = this._settings.get_boolean('favorites-section');
            const categoryGrouping = this._settings.get_boolean('category-grouping');
            // Whether to clip app labels in the grid and expand them on hover. 
            const clipLabels = this._settings.get_boolean('clip-app-labels');

            this._lastInstalledIds = this._getInstalledIdsSet();

            this._appIcons = [];
            this._categoryLabels = {};
            this._categoryViews = {};

            if (categoryGrouping) {
                // Category grouping mode - hide original mainLabel/mainView
                this._mainLabel.hide();
                this._mainView.hide();
                this._favoritesLabel.hide();
                this._favoritesView.hide();

                const categoryOrder = getCategoryOrder(this._settings);
                const categoryIcons = getCategoryIconMap(this._settings);
                const appsByCategory = this._loadAppsByCategory(categoryOrder);

                // First, add favorites section if enabled
                if (favSection && appsByCategory._favorites.length > 0) {
                    const favLabel = this._createSectionHeader(_('Favorites'));
                    const favView = new St.Viewport({
                        layout_manager: new VerticalLayout(this._settings),
                        style: 'overflow: hidden;'
                    });

                    this._categoryLabels['_favorites'] = favLabel;
                    this._categoryViews['_favorites'] = favView;

                    // Insert at the beginning to ensure favorites is always on top
                    this._scrollView.get_child().insert_child_at_index(favLabel, 0);
                    this._scrollView.get_child().insert_child_at_index(favView, 1);

                    for (const appId of appsByCategory._favorites) {
                        const app = this._appSystem.lookup_app(appId);
                        if (!app) continue;
                        const appIcon = new AppDisplay.AppIcon(app, {
                            isDraggable: false,
                            expandTitleOnHover: clipLabels
                        });
                        appIcon._appId = app.get_id();
                        this._attachDragHandlers(appIcon);
                        appIcon.icon.setIconSize(iconSize);
                        favView.add_child(appIcon);
                        this._appIcons.push(appIcon);
                    }
                }

                // Then add category sections
                for (const category of categoryOrder) {
                    const appIds = appsByCategory[category] || [];

                    const label = this._createSectionHeader(_(category));
                    const view = new St.Viewport({
                        layout_manager: new VerticalLayout(this._settings),
                        reactive: true,
                        style: 'overflow: hidden;'
                    });

                    this._categoryLabels[category] = label;
                    this._categoryViews[category] = view;

                    this._scrollView.add_child(label);
                    this._scrollView.add_child(view);

                    // Add any apps for this category (if present)
                    for (const appId of appIds) {
                        const app = this._appSystem.lookup_app(appId);
                        if (!app) continue;
                        const appIcon = new AppDisplay.AppIcon(app, {
                            isDraggable: false,
                            expandTitleOnHover: clipLabels
                        });
                        appIcon._appId = app.get_id();
                        // Attach centralized drag handlers
                        this._attachDragHandlers(appIcon);
                        appIcon.icon.setIconSize(iconSize);
                        view.add_child(appIcon);
                        this._appIcons.push(appIcon);
                    }
                }

                // Add Other category if it has apps
                if (appsByCategory['Other'] && appsByCategory['Other'].length > 0) {
                    const label = this._createSectionHeader(_('Other'));
                    const view = new St.Viewport({
                        layout_manager: new VerticalLayout(this._settings),
                        style: 'overflow: hidden;'
                    });

                    this._categoryLabels['Other'] = label;
                    this._categoryViews['Other'] = view;

                    this._scrollView.add_child(label);
                    this._scrollView.add_child(view);

                    for (const appId of appsByCategory['Other']) {
                        const app = this._appSystem.lookup_app(appId);
                        if (!app) continue;
                        const appIcon = new AppDisplay.AppIcon(app, {
                            isDraggable: false,
                            expandTitleOnHover: clipLabels
                        });
                        appIcon._appId = app.get_id();
                        this._attachDragHandlers(appIcon);
                        appIcon.icon.setIconSize(iconSize);
                        view.add_child(appIcon);
                        this._appIcons.push(appIcon);
                    }
                }

                this._buildCategoryNav(appsByCategory, categoryOrder, categoryIcons);
                this._navBox.show();
            } else {
                this._navBox.hide();
                this._destroyCategoryNav();
                // Original mode: Favorites and All Apps
                // Show original labels and views
                this._favoritesLabel.show();
                this._favoritesView.show();
                this._mainLabel.show();
                this._mainView.show();

                // Ensure favorites is at the top by reordering
                const scrollBox = this._scrollView.get_child();
                const favLabelIndex = scrollBox.get_children().indexOf(this._favoritesLabel);

                if (favLabelIndex !== 0) {
                    scrollBox.set_child_at_index(this._favoritesLabel, 0);
                    scrollBox.set_child_at_index(this._favoritesView, 1);
                }

                const syncFavorites = this._settings.get_boolean('show-favorites-in-app-grid');
                const installedApps = this._appSystem.get_installed();
                const favSorting = this._settings.get_string('favorites-sorting');
                const appSorting = this._settings.get_string('app-sorting');
                const favIds = this._appFavorites._getIds();
                const hiddenApps = new Set(this._settings.get_strv('hidden-apps'));

                const favAppInfos = [];
                const mainAppInfos = [];

                installedApps.forEach(appInfo => {
                    try {
                        if (!this._parentalControls.shouldShowApp(appInfo))
                            return;

                        const appId = appInfo.get_id();

                        if (hiddenApps.has(appId))
                            return;

                        const isFav = this._appFavorites.isFavorite(appId);

                        if (favSection && isFav) {
                            favAppInfos.push(appInfo);
                            if (!syncFavorites) return;
                        }

                        mainAppInfos.push(appInfo);
                    } catch {
                        // Skip apps that error out during filtering/lookup.
                    }
                });

                // Sort favorites
                favAppInfos.sort((a, b) => {
                    switch (favSorting) {
                        case 'dash':
                            return favIds.indexOf(a.get_id()) - favIds.indexOf(b.get_id());
                        case 'usage':
                            return this._appUsage.compare(a.get_id(), b.get_id()) || 0;
                        case 'alphabetical':
                        default:
                            return a.get_name().toLowerCase().localeCompare(b.get_name().toLowerCase());
                    }
                });

                // Sort main apps
                mainAppInfos.sort((a, b) => {
                    switch (appSorting) {
                        case 'usage':
                            return this._appUsage.compare(a.get_id(), b.get_id()) || 0;
                        case 'alphabetical':
                        default:
                            return a.get_name().toLowerCase().localeCompare(b.get_name().toLowerCase());
                    }
                });

                // Add favorites
                for (const appInfo of favAppInfos) {
                    const app = this._appSystem.lookup_app(appInfo.get_id());
                    if (!app) continue;
                    const appIcon = new AppDisplay.AppIcon(app, {
                        isDraggable: false,
                        expandTitleOnHover: clipLabels
                    });
                    appIcon.icon.setIconSize(iconSize);
                    appIcon._appId = app.get_id();
                    this._attachDragHandlers(appIcon);
                    this._favoritesView.add_child(appIcon);
                    this._appIcons.push(appIcon);
                }

                // Add main apps
                for (const appInfo of mainAppInfos) {
                    const app = this._appSystem.lookup_app(appInfo.get_id());
                    if (!app) continue;
                    const appIcon = new AppDisplay.AppIcon(app, {
                        isDraggable: false,
                        expandTitleOnHover: clipLabels
                    });
                    appIcon.icon.setIconSize(iconSize);
                    appIcon._appId = app.get_id();
                    this._attachDragHandlers(appIcon);
                    this._mainView.add_child(appIcon);
                    this._appIcons.push(appIcon);
                }

                const showFavSection = this._favoritesView.get_children().length > 0;
                const showMainSection = this._mainView.get_children().length > 0;
                const showMainLabel = showFavSection && showMainSection;

                this._favoritesLabel.visible = showFavSection;
                this._favoritesView.visible = showFavSection;
                this._mainLabel.visible = showMainLabel;
                this._mainView.visible = showMainSection;
            }

            // Extra space after the last section so it can be scrolled
            // further up rather than stopping flush with the bottom edge.
            this._bottomSpacer?.destroy();
            this._bottomSpacer = null;

            this._bottomSpacer = new St.Widget({
                x_expand: true
            });
            this._bottomSpacer.set_height(320);
            this._scrollView.add_child(this._bottomSpacer);
        }

        _buildCategoryNav(appsByCategory, categoryOrder, categoryIcons) {
            this._destroyCategoryNav();

            const visibleCategories = [];

            if (appsByCategory['_favorites'] && appsByCategory['_favorites'].length > 0) {
                visibleCategories.push({
                    id: '_favorites',
                    label: _('Favorites')
                });
            }

            for (const category of categoryOrder) {
                visibleCategories.push({
                    id: category,
                    label: _(category)
                });
            }

            if (appsByCategory['Other'] && appsByCategory['Other'].length > 0) {
                visibleCategories.push({
                    id: 'Other',
                    label: _('Other')
                });
            }

            // Record top-to-bottom order so the scroll watcher knows which
            // section follows which when deciding what's "active".
            this._categoryOrder = visibleCategories.map(item => item.id);

            const fontSize = this._settings.get_int('category-font-size');

            visibleCategories.forEach((item) => {
                const button = new St.Button({
                    x_expand: true,
                    reactive: true,
                    can_focus: true,
                    y_expand: false,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: this._getCategoryButtonStyle()
                });
                button._categoryId = item.id;

                const categoryRow = new St.BoxLayout({
                    orientation: Clutter.Orientation.HORIZONTAL,
                    x_expand: true,
                    y_expand: false,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'align-items: center;'
                });

                const icon = new St.Icon({
                    icon_name: (categoryIcons && categoryIcons.get(item.id)) || CATEGORY_ICONS[item.id] || 'applications-other-symbolic',
                    icon_size: 16,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'margin-right: 10px;',
                    opacity: ICON_OPACITY_DEFAULT
                });
                const label = new St.Label({
                    text: item.label,
                    style_class: 'search-statustext',
                    y_align: Clutter.ActorAlign.CENTER,
                    style: `font-weight: 500; font-size: ${Math.max(fontSize - 2, 11)}px; margin: 0; color: rgba(255,255,255,0.96);`
                });

                categoryRow.add_child(icon);
                categoryRow.add_child(label);
                button.add_child(categoryRow);

                button._icon = icon;
                button._label = label;
                button._isHovered = false;

                // Apply the current expanded/collapsed state immediately -
                // no animation - so a redisplay (settings change, app
                // install, etc.) doesn't flash labels or spacing for a frame.
                label.set_opacity(this._navCollapsed ? 0 : 255);
                button.set_height(this._navCollapsed ? NAV_ITEM_HEIGHT_COLLAPSED : NAV_ITEM_HEIGHT_EXPANDED);

                button._clickedId = button.connect('clicked', () => {
                    this._scrollToCategory(item.id);
                });

                // Use explicit enter/leave events rather than the St.Button
                // 'hover' property - reliable regardless of track-hover wiring.
                button._enterId = button.connect('enter-event', () => {
                    button._isHovered = true;
                    this._updateCategoryIconOpacity(button);
                });
                button._leaveId = button.connect('leave-event', () => {
                    button._isHovered = false;
                    this._updateCategoryIconOpacity(button);
                });

                this._navBox.add_child(button);
                this._navItems.push(button);
            });

            if (this._navItems.length > 0 && !this._activeCategory) {
                this._setActiveCategory(this._navItems[0]._categoryId);
            }

            this._navBox.visible = this._navItems.length > 0;
        }

        _destroyCategoryNav() {
            // Disconnecting each button's own signals before
            // destroying it prevents the first; the teardown flag (checked
            // in _setNavCollapsed) prevents the second.
            this._navTeardownInProgress = true;

            this._navItems.forEach(button => {
                if (button._clickedId) button.disconnect(button._clickedId);
                if (button._enterId) button.disconnect(button._enterId);
                if (button._leaveId) button.disconnect(button._leaveId);
                button.destroy();
            });

            this._navItems = [];
            this._activeCategory = null;
            this._categoryOrder = [];

            this._navTeardownInProgress = false;
        }

        _getCategoryButtonStyle() {
            // Background and border stay constant regardless of hover/active
            // state - only the icon reacts, see _updateCategoryIconOpacity().
            // Vertical padding here is nominal; actual row height is driven
            // explicitly via set_height() in _setNavCollapsed(). No CSS
            // width here - x_expand: true on the button already makes it
            // fill navBox's width.
            return 'margin: 1px 0; padding: 4px 8px; border-radius: 12px; text-align: left; border: none; border-bottom: 1px solid rgba(255,255,255,0.12); background-color: transparent; color: rgba(255,255,255,0.92);';
        }

        _updateCategoryIconOpacity(button) {
            if (this._navTeardownInProgress) return;
            if (!button._icon) return;

            const isActive = button._categoryId === this._activeCategory;
            const isHover = !!button._isHovered;

            let opacity = ICON_OPACITY_DEFAULT;
            if (isActive) {
                opacity = ICON_OPACITY_ACTIVE;
            } else if (isHover) {
                opacity = ICON_OPACITY_HOVER;
            }

            try {
                button._icon.set_opacity(opacity);
            } catch {
                // Actor may have been disposed mid-teardown; nothing to do.
            }
        }

        _setActiveCategory(category) {
            this._activeCategory = category;
            this._navItems.forEach(button => {
                this._updateCategoryIconOpacity(button);
            });
        }

        _scrollToCategory(category) {
            const target = this._categoryLabels[category];
            if (!target) {
                return;
            }

            // Fix flicker through categories the scroll
            this._suppressScrollActiveUpdate = true;
            if (this._suppressScrollActiveUpdateTimeoutId) {
                GLib.Source.remove(this._suppressScrollActiveUpdateTimeoutId);
            }
            this._suppressScrollActiveUpdateTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
                this._suppressScrollActiveUpdate = false;
                this._suppressScrollActiveUpdateTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });

            this._scrollView.scrollToChild(target, 'top');
            this._setActiveCategory(category);
        }

        // Fades every button's label opacity and grows/shrinks its height to
        // show category names and give icons more breathing room on hover of
        // the whole nav. Width is fixed and independent of per-button hover, 
	// which only ever touches icon opacity (see _updateCategoryIconOpacity).
        _setNavCollapsed(collapsed, animate = true) {
            if (this._navTeardownInProgress) {
                return;
            }

            if (this._navCollapsed === collapsed) {
                return;
            }

            this._navCollapsed = collapsed;

            const targetHeight = collapsed ? NAV_ITEM_HEIGHT_COLLAPSED : NAV_ITEM_HEIGHT_EXPANDED;
            const targetOpacity = collapsed ? 0 : 255;

            if (!animate) {
                this._cancelNavAnimation();
                this._navItems.forEach(button => {
                    button.set_height(targetHeight);
                    if (button._label) {
                        button._label.set_opacity(targetOpacity);
                    }
                });
                return;
            }

            this._startNavAnimation(targetHeight, targetOpacity);
        }

        _startNavAnimation(targetHeight, targetOpacity) {
            this._cancelNavAnimation();

            if (this._navItems.length === 0) {
                return;
            }

            // All buttons always move together, so the first one's current
            // (possibly mid-animation) values are a valid start point for
            // every button - this also makes reversing direction mid-flight
            // (e.g. a quick in-and-out hover) continue smoothly instead of
            // jumping back to a fixed start value.
            const first = this._navItems[0];
            let startHeight, startOpacity;
            try {
                startHeight = first.height;
                startOpacity = first._label ? first._label.opacity : targetOpacity;
            } catch {
                // Actor may have been disposed mid-teardown; bail out rather
                // than crash - the nav will simply skip this animation.
                return;
            }

            const deltaHeight = targetHeight - startHeight;
            const deltaOpacity = targetOpacity - startOpacity;

            if (deltaHeight === 0 && deltaOpacity === 0) {
                return;
            }

            this._navAnim = {
                startTime: GLib.get_monotonic_time(),
                duration: NAV_TRANSITION_DURATION * 1000,
                startHeight,
                deltaHeight,
                startOpacity,
                deltaOpacity,
                lock: null
            };

            this._navAnim.lock = global.stage.connect('after-paint', () => this._navAnimationFrame());
        }

        _navAnimationFrame() {
            const anim = this._navAnim;
            if (!anim) {
                return;
            }

            const now = GLib.get_monotonic_time();
            const progress = Math.min(Math.max((now - anim.startTime) / anim.duration, 0), 1);
            const eased = easeOutCubic(progress);

            const height = Math.round(anim.startHeight + anim.deltaHeight * eased);
            const opacity = Math.round(anim.startOpacity + anim.deltaOpacity * eased);

            this._navItems.forEach(button => {
                button.set_height(height);
                if (button._label) {
                    button._label.set_opacity(opacity);
                }
            });

            if (progress >= 1) {
                this._cancelNavAnimation();
                return;
            }

            // Keep the after-paint signal firing until the animation ends -
            // set_height()/set_opacity() above already queue a redraw as a
            // side effect of the relayout, but this makes that explicit.
            this.queue_redraw();
        }

        _cancelNavAnimation() {
            if (this._navAnim && this._navAnim.lock) {
                global.stage.disconnect(this._navAnim.lock);
            }
            this._navAnim = null;
        }

        // Walks the visible categories top-to-bottom and marks the last one
        // whose section header has scrolled to (or past) the top of the
        // viewport as active. Runs on every vadjustment 'notify::value', so
        // it stays correct across wheel scrolling, keyboard paging, and
        // programmatic scrolls (e.g. clicking a nav button) alike.
        _updateActiveCategoryFromScroll() {
            if (this._suppressScrollActiveUpdate)
                return;

            if (this._categoryOrder.length === 0)
                return;

            const scrollValue = this._scrollView.vadjustment.value;

            // Small offset so a section becomes "active" right as its header
            // reaches the top of the viewport (matches the topPadding used
            // by scrollToChild's 'top' alignment), rather than waiting for
            // it to fully clear the edge.
            const threshold = scrollValue + 20;

            let active = this._categoryOrder[0];

            for (const category of this._categoryOrder) {
                const label = this._categoryLabels[category];
                if (!label || !label.visible)
                    continue;

                const y = this._scrollView.getChildY(label);
                if (y <= threshold) {
                    active = category;
                } else {
                    break;
                }
            }

            if (active !== this._activeCategory) {
                this._setActiveCategory(active);
            }
        }

        _loadAppsByCategory(categoryOrder) {
            const installedApps = this._appSystem.get_installed();
            const favSection = this._settings.get_boolean('favorites-section');
            const syncFavorites = this._settings.get_boolean('show-favorites-in-app-grid');
            const hiddenApps = new Set(this._settings.get_strv('hidden-apps'));

            // Computed once per pass and reused for every app below - avoids
            // getAppCategory() independently re-reading and re-parsing
            // custom-categories/app-category-overrides from settings once
            // per installed app, which is wasted work since both are the
            // same for every app within a single _loadAppsByCategory() call.
            const categoryContext = getCategoryContext(this._settings);

            const appsByCategory = {};
            for (const cat of categoryOrder) {
                appsByCategory[cat] = [];
            }
            appsByCategory['Other'] = [];
            appsByCategory['_favorites'] = [];

            installedApps.forEach(appInfo => {
                try {
                    const appId = appInfo.get_id();

                    if (!this._parentalControls.shouldShowApp(appInfo))
                        return;

                    if (hiddenApps.has(appId))
                        return;

                    const isFav = this._appFavorites.isFavorite(appId);

                    // Add to favorites section if enabled
                    if (favSection && isFav) {
                        appsByCategory['_favorites'].push(appInfo);
                        // If show-favorites-in-app-grid is enabled, also add to category (don't return)
                        if (!syncFavorites) return;
                    }

                    const category = getAppCategory(appInfo, categoryContext);

                    // Defensive guard: getAppCategory() should only ever
                    // return a name that's a key here (a category from
                    // getCategoryOrder(), or 'Other'), but if a stale
                    // override or misconfigured merge target somehow slips
                    // through, fall back to 'Other' instead of crashing on
                    // .push() into an undefined bucket.
                    if (appsByCategory[category]) {
                        appsByCategory[category].push(appInfo);
                    } else {
                        appsByCategory['Other'].push(appInfo);
                    }
                } catch {
                    // Skip apps that error out during category classification.
                }
            });

            // Sort apps within each category
            const appSorting = this._settings.get_string('app-sorting');

            for (const category in appsByCategory) {
                if (category === '_favorites') continue;

                appsByCategory[category].sort((a, b) => {
                    switch (appSorting) {
                        case 'usage':
                            return this._appUsage.compare(a.get_id(), b.get_id()) || 0;
                        case 'alphabetical':
                        default:
                            return a.get_name().toLowerCase().localeCompare(b.get_name().toLowerCase());
                    }
                });

                appsByCategory[category] = appsByCategory[category].map(appInfo => appInfo.get_id());
            }

            // Apply user-defined ordering (from app-category-overrides with index)
            const orderMap = getCategoryOrderMap(this._settings);
            for (const [cat, order] of orderMap.entries()) {
                if (!appsByCategory[cat]) continue;
                const present = new Set(appsByCategory[cat]);
                const ordered = [];
                for (const id of order) {
                    if (present.has(id)) {
                        ordered.push(id);
                        present.delete(id);
                    }
                }
                // append remaining apps
                for (const id of appsByCategory[cat])
                    if (present.has(id)) ordered.push(id);
                appsByCategory[cat] = ordered;
            }

            // Sort favorites
            if (appsByCategory['_favorites'].length > 0) {
                const favSorting = this._settings.get_string('favorites-sorting');
                const favIds = this._appFavorites._getIds();

                appsByCategory['_favorites'].sort((a, b) => {
                    switch (favSorting) {
                        case 'dash':
                            return favIds.indexOf(a.get_id()) - favIds.indexOf(b.get_id());
                        case 'usage':
                            return this._appUsage.compare(a.get_id(), b.get_id()) || 0;
                        case 'alphabetical':
                        default:
                            return a.get_name().toLowerCase().localeCompare(b.get_name().toLowerCase());
                    }
                });

                appsByCategory['_favorites'] = appsByCategory['_favorites'].map(appInfo => appInfo.get_id());
            }

            return appsByCategory;
        }

        _redisplay() {
            this._animateRedisplay(() => {
                this._redisplayLater = this._laters.add(Meta.LaterType.IDLE, () => {
                    // The try/finally guarantees the fade-back-in always
                    // runs, so a bug elsewhere degrades to "redisplay didn't
                    // fully update" rather than "grid disappears".
                    try {
                        this._cancelDrag();
                        this._cancelNavAnimation();

                        this._favoritesView.destroy_all_children();
                        this._mainView.destroy_all_children();

                        // Clean up category views if they exist
                        for (const category in this._categoryLabels) {
                            this._categoryLabels[category]?.destroy();
                            this._categoryLabels[category] = null;
                        }
                        for (const category in this._categoryViews) {
                            this._destroyViewportLayout(this._categoryViews[category]);
                            this._categoryViews[category]?.destroy();
                            this._categoryViews[category] = null;
                        }
                        this._categoryLabels = {};
                        this._categoryViews = {};

                        this._addAppIcons();
                        this._updateLabelMargins();
                    } catch (e) {
                        console.error(e, 'vertigrid: redisplay failed');
                    } finally {
                        this._animateRedisplay();
                    }
                });
            });
        }

        _animateRedisplay(onComplete) {
            this._scrollView.ease({
                onComplete,
                opacity: onComplete ? 0 : 255,
                duration: SIDE_CONTROLS_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
        }

        _updateLabelMargins() {
            const spacing = this._settings.get_int('icon-spacing');

            // Fixed gap above every section after the first one. Kept independent
            // of icon-spacing since multi-line app icon labels can run tall
            // enough to butt up against the next section's separator line.
            const sectionGap = 50;

            // Original favorites label (non-category mode)
            if (this._favoritesLabel && this._favoritesLabel.visible) {
                this._favoritesLabel.set_style(`margin: 0 0 ${spacing}px 0;`);
            }
            // Original main label (non-category mode)
            if (this._mainLabel && this._mainLabel.visible) {
                this._mainLabel.set_style(`margin: ${sectionGap}px 0 ${spacing}px 0;`);
            }

            // Category labels (including _favorites in category mode)
            for (const category in this._categoryLabels) {
                if (this._categoryLabels[category] && this._categoryLabels[category].visible) {
                    if (category === '_favorites') {
                        this._categoryLabels[category].set_style(`margin: 0 0 ${spacing}px 0;`);
                    } else {
                        this._categoryLabels[category].set_style(`margin: ${sectionGap}px 0 ${spacing}px 0;`);
                    }
                }
            }
        }

        _updateIconSize() {
            const size = this._settings.get_int('icon-size');

            this._appIcons.forEach(appIcon => {
                appIcon.icon.setIconSize(size);
            });
        }

        _getEventCoords(event) {
            try {
                if (event && event.get_coords) {
                    const coords = event.get_coords();
                    return [Math.floor(coords[0]), Math.floor(coords[1])];
                }

                const p = global.get_pointer();
                if (p && p.length >= 2) {
                    // Some environments return [device, x, y]
                    if (p.length >= 3) return [Math.floor(p[1]), Math.floor(p[2])];
                    return [Math.floor(p[0]), Math.floor(p[1])];
                }
            } catch {
                // Fall through to the [0, 0] default below.
            }

            return [0, 0];
        }

        _findCategoryViewFromActor(actor) {
            let target = actor;
            while (target) {
                for (const cat in this._categoryViews) {
                    if (this._categoryViews[cat] === target) {
                        return {
                            view: this._categoryViews[cat],
                            category: cat
                        };
                    }
                }
                target = target.get_parent();
            }
            return {
                view: null,
                category: null
            };
        }

        // Gives empty category viewports a temporary pickable area for the
        // duration of a drag. Add real, but invisible child. Removed again once
        // the drag ends, so browsing the grid normally is unaffected.
        _setEmptyCategoryDropTargetsActive(active) {
            const size = this._settings.get_int('icon-size');

            for (const category in this._categoryViews) {
                const view = this._categoryViews[category];
                if (!view) continue;

                if (active) {
                    if (view.get_children().length === 0) {
                        view._dropPlaceholder = new St.Widget({
                            width: size,
                            height: size
                        });
                        view.add_child(view._dropPlaceholder);
                    }
                } else if (view._dropPlaceholder) {
                    view._dropPlaceholder.destroy();
                    view._dropPlaceholder = null;
                }
            }
        }

        _startDrag(actor) {
            try {
                this._setEmptyCategoryDropTargetsActive(true);

                // Ensure any previous drag state is cleared
                if (this._dragGhost) {
                    this._dragGhost.destroy();
                    this._dragGhost = null;
                }

                this._dragActor = actor;
                actor._dragging = true;

                // Create drag ghost
                try {
                    this._dragGhost = new Clutter.Clone({
                        source: actor
                    });
                    this._dragGhost.set_opacity(200);
                    this._dragGhost.set_scale(0.9, 0.9);
                    try {
                        this._dragGhost.set_reactive(false);
                    } catch {
                        // Not critical if this fails; the ghost just stays reactive.
                    }
                    global.stage.add_child(this._dragGhost);
                    this._dragGhost.raise_top();
                } catch {
                    // Ghost creation is best-effort; a failure here just
                    // means no visual clone follows the pointer.
                }

                // Connect a single capture-phase listener for both motion
                // and release while dragging. 
                if (this._dragCapturedHandler) {
                    try {
                        global.stage.disconnect(this._dragCapturedHandler);
                    } catch {
                        // Already disconnected; nothing to do.
                    }
                    this._dragCapturedHandler = null;
                }

                this._dragCapturedHandler = global.stage.connect('captured-event', (stage, event) => {
                    const eventType = event.type();

                    if (eventType === Clutter.EventType.MOTION) {
                        if (!this._dragActor) {
                            return Clutter.EVENT_PROPAGATE;
                        }
                        try {
                            const [mx, my] = this._getEventCoords(event);
                            if (this._dragGhost) {
                                const [w, h] = [this._dragGhost.get_width(), this._dragGhost.get_height()];
                                this._dragGhost.set_position(Math.floor(mx - w / 2), Math.floor(my - h / 2));
                            }

                            const target = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, mx, my);
                            const found = this._findCategoryViewFromActor(target);
                            const foundView = found.view;
                            if (foundView !== this._highlightedView) {
                                try {
                                    if (this._highlightedView) this._highlightedView.set_style('');
                                } catch {
                                    // View may have been disposed mid-drag; nothing to do.
                                }
                                this._highlightedView = foundView;
                                try {
                                    if (this._highlightedView) this._highlightedView.set_style('box-shadow: inset 0 0 0 2px rgba(255,255,255,0.08); background-color: rgba(255,255,255,0.02);');
                                } catch {
                                    // View may have been disposed mid-drag; nothing to do.
                                }
                            }
                        } catch {
                            // Motion handling is best-effort per frame; skip
                            // this frame rather than crash the pointer grab.
                        }
                        // Consume it - nothing else (including GNOME's own
                        // handlers) should react to pointer motion while a
                        // drag ghost is being dragged around.
                        return Clutter.EVENT_STOP;
                    }

                    if (eventType === Clutter.EventType.BUTTON_RELEASE) {
                        if (!this._dragActor) {
                            return Clutter.EVENT_PROPAGATE;
                        }
                        try {
                            const src = this._dragActor;
                            src._dragging = false;
                            const [rx, ry] = this._getEventCoords(event);

                            const targetActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, rx, ry);

                            const found = this._findCategoryViewFromActor(targetActor);
                            if (found.view) {
                                const cat = found.category;
                                const destView = found.view;

                                // Computing the slot geometrically - the same
                                // row/column formula VerticalLayout itself uses
                                // to lay out children - gives a consistent,
                                // correct index regardless of whether the
                                // pointer landed on an icon or on empty grid space.
                                const insertIndex = this._computeGridInsertIndex(destView, rx, ry);

                                // Build the full resulting order for this
                                // category and write an explicit index for
                                // every app in it via setCategoryOrder(),
                                // rather than only ever writing an index for
                                // the one dragged app via setAppCategory().
                                const currentIds = destView.get_children()
                                    .map(child => child._appId)
                                    .filter(Boolean);

                                const draggedId = src._appId;
                                const withoutDragged = currentIds.filter(id => id !== draggedId);
                                const clampedIndex = Math.min(Math.max(insertIndex, 0), withoutDragged.length);
                                withoutDragged.splice(clampedIndex, 0, draggedId);

                                try {
                                    setCategoryOrder(this._settings, cat, withoutDragged);
                                } catch {
                                    setAppCategory(this._settings, src._appId, cat);
                                }

                                this._redisplay();
                            }
                        } catch (e) {
                            console.debug(`vertigrid: release handler exception=${e}`);
                        }

                        this._cancelActiveDrag();

                        // Consume the release too - this is the critical part:
                        // without this, GNOME's own capture-phase background-
                        // click handler would still see this same release and
                        // close the overview, since a drop onto empty category
                        // space has no reactive actor under the pointer for it
                        // to distinguish from an ordinary background click.
                        return Clutter.EVENT_STOP;
                    }

                    return Clutter.EVENT_PROPAGATE;
                });
            } catch {
                // Starting a drag is best-effort; a failure here just means
                // this particular drag gesture doesn't begin.
            }
        }

        _cancelPendingDrag() {
            if (this._pendingMotionId) {
                global.stage.disconnect(this._pendingMotionId);
                this._pendingMotionId = null;
            }
            if (this._pendingReleaseId) {
                global.stage.disconnect(this._pendingReleaseId);
                this._pendingReleaseId = null;
            }
        }

        _cancelActiveDrag() {
            this._setEmptyCategoryDropTargetsActive(false);

            if (this._dragCapturedHandler) {
                global.stage.disconnect(this._dragCapturedHandler);
                this._dragCapturedHandler = null;
            }
            if (this._dragGhost) {
                this._dragGhost.destroy();
                this._dragGhost = null;
            }
            if (this._highlightedView) {
                this._highlightedView.set_style('');
                this._highlightedView = null;
            }
            if (this._dragActor) {
                this._dragActor._dragging = false;
                this._dragActor = null;
            }
        }

        // Cancels both a not-yet-started (pending) drag watch and a fully
        // in-progress drag (ghost clone + its stage listeners). Used whenever
        // we know for certain no drag should be active - e.g. once the
        // overview closes, since a launched app can consume the release event
        // before our stage-level listener ever sees it, otherwise leaving a
        // dangling motion watch that spawns a stray ghost on the next mouse
        // move anywhere on screen.
        _cancelDrag() {
            this._cancelPendingDrag();
            this._cancelActiveDrag();
        }

        // Call this before destroying any viewport that was
        // constructed with `new VerticalLayout(...)`.
        _destroyViewportLayout(viewport) {
            const layoutManager = viewport && viewport.layout_manager;
            if (layoutManager) {
                layoutManager.destroy();
            }
        }

        _showFullAppLabel(appIcon) {
            // AppDisplay.AppIcon truncates the name to a single ellipsized
            // line by default and only shows the full name as a hover
            // overlay. Force it to always wrap onto multiple lines instead.
            const clutterText = appIcon.icon.label.clutter_text;
            clutterText.set_line_wrap(true);
            clutterText.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            clutterText.set_single_line_mode(false);
            clutterText.ellipsize = Pango.EllipsizeMode.END;
            appIcon.icon.label.set_style('text-align: center;');
        }

        _attachDragHandlers(appIcon) {
            // If the user has disabled clipping of app labels, force the label to always wrap onto multiple lines instead of being ellipsized to a single line. 
            // This prevents AppIcon's internal hover/focus-driven single-line <-> wrapped toggling from fighting with the always-wrapped style applied here.

            if (!this._settings.get_boolean('clip-app-labels')) {
                this._showFullAppLabel(appIcon);
            }

            appIcon.reactive = true;
            appIcon.connect('button-press-event', (actor, event) => {
                try {
                    const [x, y] = this._getEventCoords(event);
                    actor._dragStart = {
                        x,
                        y
                    };

                    // Small threshold before starting an actual drag (px)
                    const threshold = 8;

                    // Clean any pending handlers
                    this._cancelPendingDrag();

                    // Pending motion handler: wait until pointer moves beyond threshold
                    this._pendingMotionId = global.stage.connect('motion-event', (stage, motionEvent) => {
                        try {
                            const [mx, my] = this._getEventCoords(motionEvent);
                            const dx = mx - actor._dragStart.x;
                            const dy = my - actor._dragStart.y;
                            const distSq = dx * dx + dy * dy;
                            if (distSq >= threshold * threshold) {
                                // start actual drag
                                this._cancelPendingDrag();
                                this._startDrag(actor);
                            }
                        } catch {
                            // Motion handling is best-effort per frame; skip
                            // this frame rather than crash the pointer grab.
                        }
                        return Clutter.EVENT_PROPAGATE;
                    });

                    // If released before threshold, cancel pending drag
                    this._pendingReleaseId = global.stage.connect('button-release-event', () => {
                        this._cancelPendingDrag();
                        return Clutter.EVENT_PROPAGATE;
                    });
                } catch {
                    // Setting up the pending-drag watch is best-effort; a
                    // failure here just means this press doesn't start one.
                }
                return Clutter.EVENT_PROPAGATE;
            });

            // Belt-and-suspenders: also listen directly on the icon itself.
            // A normal click (which launches the app) always fires this on
            // the icon before the icon's own class handler runs, so it's a
            // reliable way to cancel the pending-drag watch even in cases
            // where the click ends up consuming the event before it reaches
            // the global.stage listener above.
            appIcon.connect('button-release-event', () => {
                this._cancelPendingDrag();
                return Clutter.EVENT_PROPAGATE;
            });
        }

        vfunc_key_press_event(event) {
            const key = event.get_key_symbol();
            const focused = global.stage.get_key_focus();

            if (key === Clutter.KEY_Escape) {
                return Clutter.EVENT_PROPAGATE;
            }

            // Keyboard scroll
            const adjustment = this._scrollView.vadjustment;
            const pageSize = adjustment.page_size;

            const scroll = {
                [Clutter.KEY_Home]: 0,
                [Clutter.KEY_End]: adjustment.upper - pageSize,
                [Clutter.KEY_Page_Up]: this._scrollView.scroll - pageSize * 0.8,
                [Clutter.KEY_Page_Down]: this._scrollView.scroll + pageSize * 0.8
            };

            if (scroll[key] !== undefined) {
                return this._scrollView.scrollTo(scroll[key]);
            }

            // Tab and arrow key navigation
            const navTarget = this._getNavTarget(focused, key);

            if (navTarget) {
                this._scrollView.scrollToChild(navTarget);
                navTarget.grab_key_focus();

                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        }

        _getNavTarget(focused, key) {
            if (key === Clutter.KEY_Tab || key === Clutter.KEY_ISO_Left_Tab) {
                const index = this._appIcons.indexOf(focused);
                const last = this._appIcons.length - 1;

                if (index === -1) {
                    return key === Clutter.KEY_Tab ? this._appIcons[0] : this._appIcons[last];
                }

                if (key === Clutter.KEY_Tab) {
                    return this._appIcons[index < last ? index + 1 : 0];
                }
                return this._appIcons[index > 0 ? index - 1 : last];
            }

            if (key === Clutter.KEY_Right || key === Clutter.KEY_Left ||
                key === Clutter.KEY_Down || key === Clutter.KEY_Up) {
                return this._getGridNavTarget(focused, key);
            }

            // Any other key (Enter/Space to launch, letters for type-ahead,
            // etc.) isn't ours to handle - return null so the caller lets
            // it propagate normally instead of re-focusing/consuming it.
            return null;
        }

        // Grid navigation: arrow keys move in the obvious direction, wrapping
        // around to the next/previous section when reaching the end of a row
        // or column. Up/Down always land on the first icon of the next/prev
        // section, rather than trying to preserve a column index, so that
        // Up/Down behave consistently regardless of how many rows/columns
        // the section you're leaving or entering happens to have.
        _getGridNavTarget(focused, key) {
            const index = this._appIcons.indexOf(focused);

            if (index === -1) {
                if (key === Clutter.KEY_Right || key === Clutter.KEY_Down) {
                    return this._appIcons[0];
                }
                return this._appIcons[this._appIcons.length - 1];
            }

            const parentView = focused.get_parent();
            const layout = parentView.layout_manager;
            const columns = Math.max(1, layout._columns);
            const viewChildren = parentView.get_children();
            const localIndex = viewChildren.indexOf(focused);
            const last = this._appIcons.length - 1;

            if (key === Clutter.KEY_Right || key === Clutter.KEY_Left) {
                const targetLocalIndex = key === Clutter.KEY_Right ? localIndex + 1 : localIndex - 1;
                if (localIndex !== -1 && targetLocalIndex >= 0 && targetLocalIndex < viewChildren.length) {
                    return viewChildren[targetLocalIndex];
                }

                const forward = key === Clutter.KEY_Right;
                if (forward) {
                    return this._appIcons[index < last ? index + 1 : 0];
                }
                return this._appIcons[index > 0 ? index - 1 : last];
            }

            // Up/Down: try moving a full row within the current section's
            // own grid first.
            if (localIndex !== -1) {
                const targetLocalIndex = key === Clutter.KEY_Down ? localIndex + columns : localIndex - columns;
                if (targetLocalIndex >= 0 && targetLocalIndex < viewChildren.length) {
                    return viewChildren[targetLocalIndex];
                }
            }

            // If that fails, move to the first icon of the next/previous section instead.
            if (key === Clutter.KEY_Down) {
                const lastInView = viewChildren.length > 0 ? viewChildren[viewChildren.length - 1] : focused;
                const targetIndex = this._appIcons.indexOf(lastInView) + 1;
                return this._appIcons[targetIndex <= last ? targetIndex : 0];
            }

            const firstInView = viewChildren.length > 0 ? viewChildren[0] : focused;
            const prevSectionLastIndex = this._appIcons.indexOf(firstInView) - 1;
            const prevSectionLastIcon = this._appIcons[prevSectionLastIndex >= 0 ? prevSectionLastIndex : last];
            const prevView = prevSectionLastIcon.get_parent();
            const prevViewChildren = prevView ? prevView.get_children() : [prevSectionLastIcon];
            return prevViewChildren.length > 0 ? prevViewChildren[0] : prevSectionLastIcon;
        }

        // Tear down widget state and disconnect all signals when the app grid
        // is destroyed.
        destroy() {
            this._appSystem.disconnectObject(this);
            this._appFavorites.disconnectObject(this);
            this._parentalControls.disconnectObject(this);
            this._overview.disconnectObject(this);
            this._settings.disconnectObject(this);

            this._scrollView.vadjustment.disconnect(this._scrollValueHandler);
            this._scrollValueHandler = null;

            this._cancelDrag();
            this._cancelNavAnimation();

            if (this._suppressScrollActiveUpdateTimeoutId) {
                GLib.Source.remove(this._suppressScrollActiveUpdateTimeoutId);
                this._suppressScrollActiveUpdateTimeoutId = null;
            }

            if (this._redisplayLater) {
                this._laters.remove(this._redisplayLater);
            }

            // See the comment on _destroyViewportLayout(): none of these
            // viewports' layout managers get their destroy() called just by
            // destroying the actor tree below via super.destroy(), so their
            // settings 'changed' connections need releasing explicitly here
            // too - covers _favoritesView/_mainView (only ever created once,
            // in _init()) and any category viewports still live if destroy()
            // is called without a prior _redisplay() having already cleared
            // them.
            this._destroyViewportLayout(this._favoritesView);
            this._destroyViewportLayout(this._mainView);
            for (const category in this._categoryViews) {
                this._destroyViewportLayout(this._categoryViews[category]);
            }

            for (const appIcon of this._appIcons) {
                try {
                    appIcon.destroy();
                } catch {
                    // AppDisplay.AppIcon is a Shell-internal class; guard
                    // against it already being torn down by the actor tree
                    // destroy below rather than assume it's always safe.
                }
            }

            super.destroy();
        }
    });
