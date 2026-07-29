import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

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
    getCategoryOrderMap
} from './categories.js';

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

export const VerticalAppDisplay = GObject.registerClass(
    class VerticalAppDisplay extends St.Widget {
        // Main custom app grid widget shown in the GNOME overview.
        _init(settings) {
            this._settings = settings;
            this._laters = global.compositor.get_laters();

            super._init({
                layout_manager: new Clutter.BinLayout(),
                can_focus: true,
                reactive: true
            });

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
                vertical: true,
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
                vertical: false,
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
                // asked for it to always stay expanded - otherwise this ran
                // unconditionally on every close, fighting the setting: it
                // set _navCollapsed = true regardless, and since hover is
                // intentionally a no-op while always-visible is on, nothing
                // ever re-expanded it on the next open.
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
            this._settings.connectObject('changed', (_, key) => {
                switch (key) {
                    case 'app-sorting':
                    case 'favorites-section':
                    case 'favorites-sorting':
                    case 'category-grouping':
                    case 'show-favorites-in-app-grid':
                    case 'category-font-size':
                    case 'custom-categories':
                    case 'clip-app-labels':
                        return this._redisplay();

                    case 'icon-spacing':
                        return this._updateLabelMargins();

                    case 'icon-size':
                        return this._updateIconSize();

                    case 'always-show-category-nav':
                        return this._updateNavAlwaysVisible();
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
                vertical: false,
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

        // Computes where in destView's child list a drop at stage
        // coordinates (stageX, stageY) should land, using the same
        // row/column formula VerticalLayout uses to actually place
        // children (col = i % columns, row = floor(i / columns)) run in
        // reverse. This works uniformly whether the pointer is over an
        // icon or over a gap between/after icons.
        _computeGridInsertIndex(destView, stageX, stageY) {
            try {
                const children = destView.get_children();

                let viewPos = [0, 0];
                if (destView.translate_coordinates) {
                    viewPos = destView.translate_coordinates(global.stage, 0, 0);
                } else if (destView.get_transformed_position) {
                    viewPos = destView.get_transformed_position();
                }

                const localX = stageX - viewPos[0];
                const localY = stageY - viewPos[1];

                const layout = destView.layout_manager;
                const columns = Math.max(1, layout._columns || 1);
                const spacing = layout._spacing || 0;
                const childSize = layout._getMinChildSize ?
                    layout._getMinChildSize(children) : 0;
                const cellSize = childSize + spacing;

                if (cellSize <= 0 || children.length === 0) {
                    return children.length;
                }

                const col = Math.min(columns - 1, Math.max(0, Math.floor(localX / cellSize)));
                const row = Math.max(0, Math.floor(localY / cellSize));

                const index = row * columns + col;
                return Math.min(Math.max(index, 0), children.length);
            } catch (e) {
                try {
                    return destView.get_children().length;
                } catch (e2) {
                    return 0;
                }
            }
        }

        _getInstalledIdsSet() {
            const ids = new Set();
            try {
                this._appSystem.get_installed().forEach(appInfo => {
                    try {
                        ids.add(appInfo.get_id());
                    } catch (e) {}
                });
            } catch (e) {}
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

                const categoryOrder = getCategoryOrder();
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
                            isDraggable: false
                        });
                        try {
                            appIcon._appId = app.get_id();
                        } catch (e) {}
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
                            isDraggable: false
                        });
                        try {
                            appIcon._appId = app.get_id();
                        } catch (e) {}
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
                            isDraggable: false
                        });
                        try {
                            appIcon._appId = app.get_id();
                        } catch (e) {}
                        this._attachDragHandlers(appIcon);
                        appIcon.icon.setIconSize(iconSize);
                        view.add_child(appIcon);
                        this._appIcons.push(appIcon);
                    }
                }

                this._buildCategoryNav(appsByCategory, categoryOrder);
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

                const favAppInfos = [];
                const mainAppInfos = [];

                installedApps.forEach(appInfo => {
                    try {
                        if (!this._parentalControls.shouldShowApp(appInfo))
                            return;

                        const appId = appInfo.get_id();
                        const isFav = this._appFavorites.isFavorite(appId);

                        if (favSection && isFav) {
                            favAppInfos.push(appInfo);
                            if (!syncFavorites) return;
                        }

                        mainAppInfos.push(appInfo);
                    } catch {}
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
                        isDraggable: false
                    });
                    appIcon.icon.setIconSize(iconSize);
                    try {
                        appIcon._appId = app.get_id();
                    } catch (e) {}
                    this._attachDragHandlers(appIcon);
                    this._favoritesView.add_child(appIcon);
                    this._appIcons.push(appIcon);
                }

                // Add main apps
                for (const appInfo of mainAppInfos) {
                    const app = this._appSystem.lookup_app(appInfo.get_id());
                    if (!app) continue;
                    const appIcon = new AppDisplay.AppIcon(app, {
                        isDraggable: false
                    });
                    appIcon.icon.setIconSize(iconSize);
                    try {
                        appIcon._appId = app.get_id();
                    } catch (e) {}
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
            if (this._bottomSpacer) {
                try {
                    this._bottomSpacer.destroy();
                } catch (e) {}
                this._bottomSpacer = null;
            }

            this._bottomSpacer = new St.Widget({
                x_expand: true
            });
            this._bottomSpacer.set_height(320);
            this._scrollView.add_child(this._bottomSpacer);
        }

        _buildCategoryNav(appsByCategory, categoryOrder) {
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
                    vertical: false,
                    x_expand: true,
                    y_expand: false,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'align-items: center;'
                });

                const icon = new St.Icon({
                    icon_name: CATEGORY_ICONS[item.id] || 'applications-other-symbolic',
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
                try {
                    if (button._clickedId) button.disconnect(button._clickedId);
                    if (button._enterId) button.disconnect(button._enterId);
                    if (button._leaveId) button.disconnect(button._leaveId);
                } catch (e) {}
                try {
                    button.destroy();
                } catch (e) {}
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
            } catch (e) {
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
                GLib.source_remove(this._suppressScrollActiveUpdateTimeoutId);
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
            } catch (e) {
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

            if (!this._categoryOrder || this._categoryOrder.length === 0)
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

            // Computed once per pass and reused for every app below - avoids
            // getAppCategory() independently re-reading and re-parsing
            // custom-categories/app-category-overrides from settings once
            // per installed app, which is wasted work since both are the
            // same for every app within a single _loadAppsByCategory() call.
            const categoryContext = getCategoryContext();

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
                } catch {}
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
            try {
                const orderMap = getCategoryOrderMap();
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
            } catch (e) {}

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
                            if (this._categoryLabels[category]) {
                                this._categoryLabels[category].destroy();
                                this._categoryLabels[category] = null;
                            }
                        }
                        for (const category in this._categoryViews) {
                            if (this._categoryViews[category]) {
                                this._destroyViewportLayout(this._categoryViews[category]);
                                this._categoryViews[category].destroy();
                                this._categoryViews[category] = null;
                            }
                        }
                        this._categoryLabels = {};
                        this._categoryViews = {};

                        this._addAppIcons();
                        this._updateLabelMargins();
                    } catch (e) {
                        logError(e, 'vertigrid: redisplay failed');
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
            } catch (e) {}

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
                try {
                    target = target.get_parent();
                } catch (e) {
                    target = null;
                }
            }
            return {
                view: null,
                category: null
            };
        }

        _findCategoryViewAtStagePoint(x, y) {
            for (const cat in this._categoryViews) {
                const view = this._categoryViews[cat];
                if (!view) continue;

                let viewPos = [0, 0];
                try {
                    if (view.translate_coordinates) {
                        viewPos = view.translate_coordinates(global.stage, 0, 0);
                    } else if (view.get_transformed_position) {
                        viewPos = view.get_transformed_position();
                    }
                } catch (e) {}

                let bounds = null;
                try {
                    bounds = view.get_allocation_box();
                } catch (e) {}

                // If the view has no allocation (empty), try to allow dropping
                // on the area under the category label so users can drop into
                // empty categories.
                let width = 0;
                let height = 0;
                if (bounds) {
                    width = bounds.x2 - bounds.x1;
                    height = bounds.y2 - bounds.y1;
                }

                // Primary hit-test: view bounds
                if (bounds && x >= viewPos[0] && x <= viewPos[0] + width && y >= viewPos[1] && y <= viewPos[1] + height) {
                    return {
                        view,
                        category: cat
                    };
                }

                // If view is effectively empty (very small height), expand drop area
                // to include the label and a small region below it so dragging
                // into empty categories works.
                try {
                    if (!bounds || height <= 2) {
                        const label = this._categoryLabels[cat];
                        if (label) {
                            let labelPos = [0, 0];
                            try {
                                if (label.translate_coordinates) {
                                    labelPos = label.translate_coordinates(global.stage, 0, 0);
                                } else if (label.get_transformed_position) {
                                    labelPos = label.get_transformed_position();
                                }
                            } catch (e) {}

                            let labelBox = null;
                            try {
                                labelBox = label.get_allocation_box();
                            } catch (e) {}

                            const labelWidth = labelBox ? (labelBox.x2 - labelBox.x1) : Math.max(64, width);
                            const labelHeight = labelBox ? (labelBox.y2 - labelBox.y1) : 24;

                            // Default padding for a generous empty-category
                            // drop target, but clamped below so it can
                            // never extend past wherever the next visible
                            // category's own header sits - otherwise a
                            // sparsely-populated category's drop zone can
                            // bleed into its neighbor's space and steal
                            // drops meant for that category.
                            let dropPadding = 160;
                            try {
                                const orderIdx = this._categoryOrder ? this._categoryOrder.indexOf(cat) : -1;
                                if (orderIdx !== -1 && orderIdx + 1 < this._categoryOrder.length) {
                                    const nextCat = this._categoryOrder[orderIdx + 1];
                                    const nextLabel = this._categoryLabels[nextCat];
                                    if (nextLabel) {
                                        let nextLabelPos = [0, 0];
                                        if (nextLabel.translate_coordinates) {
                                            nextLabelPos = nextLabel.translate_coordinates(global.stage, 0, 0);
                                        } else if (nextLabel.get_transformed_position) {
                                            nextLabelPos = nextLabel.get_transformed_position();
                                        }
                                        const gapToNext = nextLabelPos[1] - (labelPos[1] + labelHeight);
                                        if (gapToNext > 0) {
                                            // Leave a small buffer before the next header rather than touching it exactly.
                                            dropPadding = Math.max(20, Math.min(dropPadding, gapToNext - 10));
                                        }
                                    }
                                }
                            } catch (e) {}

                            const dropX1 = labelPos[0];
                            const dropX2 = labelPos[0] + labelWidth;
                            const dropY1 = labelPos[1];
                            const dropY2 = labelPos[1] + labelHeight + dropPadding;

                            if (x >= dropX1 && x <= dropX2 && y >= dropY1 && y <= dropY2) {
                                return {
                                    view,
                                    category: cat
                                };
                            }
                        }
                    }
                } catch (e) {}
            }
            return {
                view: null,
                category: null
            };
        }

        _startDrag(actor) {
            try {
                // Ensure any previous drag state is cleared
                if (this._dragGhost) {
                    try {
                        global.stage.remove_child(this._dragGhost);
                    } catch (e) {}
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
                    } catch (e) {}
                    global.stage.add_child(this._dragGhost);
                    this._dragGhost.raise_top();
                } catch (e) {}

                // Connect a single capture-phase listener for both motion
                // and release while dragging. 
                if (this._dragCapturedHandler) {
                    try {
                        global.stage.disconnect(this._dragCapturedHandler);
                    } catch (e) {}
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
                            let found = this._findCategoryViewFromActor(target);
                            if (!found.view) {
                                found = this._findCategoryViewAtStagePoint(mx, my);
                            }
                            const foundView = found.view;
                            if (foundView !== this._highlightedView) {
                                try {
                                    if (this._highlightedView) this._highlightedView.set_style('');
                                } catch (e) {}
                                this._highlightedView = foundView;
                                try {
                                    if (this._highlightedView) this._highlightedView.set_style('box-shadow: inset 0 0 0 2px rgba(255,255,255,0.08); background-color: rgba(255,255,255,0.02);');
                                } catch (e) {}
                            }
                        } catch (e) {}
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

                            let found = this._findCategoryViewFromActor(targetActor);
                            if (!found.view) {
                                found = this._findCategoryViewAtStagePoint(rx, ry);
                            }
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
                                    setCategoryOrder(cat, withoutDragged);
                                } catch (e) {
                                    setAppCategory(src._appId, cat);
                                }

                                this._redisplay();
                            }
                        } catch (e) {
                            log(`vertigrid: release handler exception=${e}`);
                        }

                        try {
                            global.stage.disconnect(this._dragCapturedHandler);
                        } catch (e) {}
                        this._dragCapturedHandler = null;

                        if (this._dragGhost) {
                            try {
                                global.stage.remove_child(this._dragGhost);
                            } catch (e) {}
                            this._dragGhost = null;
                        }

                        this._dragActor = null;
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
            } catch (e) {}
        }

        _cancelPendingDrag() {
            if (this._pendingMotionId) {
                try {
                    global.stage.disconnect(this._pendingMotionId);
                } catch (e) {}
                this._pendingMotionId = null;
            }
            if (this._pendingReleaseId) {
                try {
                    global.stage.disconnect(this._pendingReleaseId);
                } catch (e) {}
                this._pendingReleaseId = null;
            }
        }

        _cancelActiveDrag() {
            if (this._dragCapturedHandler) {
                try {
                    global.stage.disconnect(this._dragCapturedHandler);
                } catch (e) {}
                this._dragCapturedHandler = null;
            }
            if (this._dragGhost) {
                try {
                    global.stage.remove_child(this._dragGhost);
                } catch (e) {}
                this._dragGhost = null;
            }
            if (this._highlightedView) {
                try {
                    this._highlightedView.set_style('');
                } catch (e) {}
                this._highlightedView = null;
            }
            if (this._dragActor) {
                try {
                    this._dragActor._dragging = false;
                } catch (e) {}
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
            try {
                const layoutManager = viewport && viewport.layout_manager;
                if (layoutManager && typeof layoutManager.destroy === 'function') {
                    layoutManager.destroy();
                }
            } catch (e) {}
        }

        _findLabelActor(actor) {
            if (actor instanceof St.Label) {
                return actor;
            }

            const children = actor.get_children ? actor.get_children() : [];
            for (const child of children) {
                const found = this._findLabelActor(child);
                if (found) {
                    return found;
                }
            }

            return null;
        }

        _showFullAppLabel(appIcon) {
            // AppDisplay.AppIcon truncates the name to a single ellipsized
            // line by default and only shows the full name as a hover
            // overlay. Force it to always wrap onto multiple lines instead.
            let label = null;
            try {
                if (appIcon.icon && appIcon.icon.label instanceof St.Label) {
                    label = appIcon.icon.label;
                } else if (appIcon.label instanceof St.Label) {
                    label = appIcon.label;
                } else {
                    label = this._findLabelActor(appIcon);
                }
            } catch (e) {}

            if (!label || !label.clutter_text) return;

            try {
                const clutterText = label.clutter_text;
                clutterText.set_line_wrap(true);
                clutterText.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
                clutterText.set_single_line_mode(false);
                clutterText.ellipsize = Pango.EllipsizeMode.END;
                label.set_style('text-align: center;');
            } catch (e) {}
        }

        _attachDragHandlers(appIcon) {
            // Respect the "clip long app names" setting: when it's enabled,
            // leave AppDisplay.AppIcon's stock single-line ellipsized label
            // behavior (full name only on hover, via its own overlay) alone
            // instead of forcing the full wrapped name below. Default is
            // false, matching the previous always-full-name behavior.
            if (!this._settings.get_boolean('clip-app-labels')) {
                this._showFullAppLabel(appIcon);

                // AppIcon's own built-in hover handling reverts the label back
                // to a single ellipsized line once the pointer leaves.
                // Re-apply our override every time hover changes so it always
                // wins, regardless of what the built-in handler just did.
                appIcon.connect('notify::hover', () => {
                    this._showFullAppLabel(appIcon);
                });
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
                        } catch (e) {}
                        return Clutter.EVENT_PROPAGATE;
                    });

                    // If released before threshold, cancel pending drag
                    this._pendingReleaseId = global.stage.connect('button-release-event', () => {
                        this._cancelPendingDrag();
                        return Clutter.EVENT_PROPAGATE;
                    });
                } catch (e) {}
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
            const index = this._appIcons.indexOf(focused);
            const last = this._appIcons.length - 1;

            let targetIndex = index;

            if (index === -1) {
                if (key === Clutter.KEY_Tab) {
                    targetIndex = 0;
                } else if (key === Clutter.KEY_ISO_Left_Tab) {
                    targetIndex = last;
                }
            } else {
                if (key === Clutter.KEY_Tab) {
                    targetIndex = index < last ? index + 1 : 0;
                } else if (key === Clutter.KEY_ISO_Left_Tab) {
                    targetIndex = index > 0 ? index - 1 : last;
                }
            }

            return this._appIcons[targetIndex];
        }

        // Tear down widget state and disconnect all signals when the app grid
        // is destroyed.
        destroy() {
            this._appSystem.disconnectObject(this);
            this._appFavorites.disconnectObject(this);
            this._parentalControls.disconnectObject(this);
            this._overview.disconnectObject(this);
            this._settings.disconnectObject(this);

            if (this._scrollValueHandler) {
                try {
                    this._scrollView.vadjustment.disconnect(this._scrollValueHandler);
                } catch (e) {}
                this._scrollValueHandler = null;
            }

            this._cancelDrag();
            this._cancelNavAnimation();

            if (this._suppressScrollActiveUpdateTimeoutId) {
                GLib.source_remove(this._suppressScrollActiveUpdateTimeoutId);
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
                } catch (e) {}
            }

            super.destroy();
        }
    });

const VerticalScrollView = GObject.registerClass(
    class VerticalScrollView extends St.ScrollView {
        // Custom scroll view with animated scrolling and precise child targeting.
        _init(settings) {
            super._init({
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.NEVER
            });

            this._settings = settings;
            this._scroll = 0;
            this._scrollAnim = {
                lock: null,
                startTime: 0,
                startValue: 0,
                delta: 0,
                duration: 0
            };
            this._trackpadTime = 0;

            const box = new St.BoxLayout({
                vertical: true,
                x_expand: false,
                y_expand: false
            });

            this._scrollBox = box;
            this.set_child(box);
        }

        add_child(child) {
            this._scrollBox.add_child(child);
        }

        get_child() {
            return this._scrollBox;
        }

        // Returns the child's vertical offset from the top of the scroll
        // view's content, in the same coordinate space as vadjustment.value.
        // Shared by scrollToChild() and the active-category scroll watcher
        // so both agree on exactly where a given section sits.
        getChildY(child) {
            const childBox = child.get_allocation_box();
            let actor = child;
            let childY = childBox.y1;

            while ((actor = actor.get_parent()) !== this) {
                if (!actor)
                    return childY;
                childY += actor.get_allocation_box().y1;
            }

            return childY;
        }

        scrollToChild(child, align = 'center') {
            const childY = this.getChildY(child);
            const childBox = child.get_allocation_box();

            const adjustment = this.vadjustment;

            let scroll;
            if (align === 'top') {
                // Scroll so the child sits at the top of the viewport, with a
                // small amount of breathing room above it.
                const topPadding = 8;
                scroll = childY - topPadding;
            } else {
                // Scroll to keep the child vertically centered
                const childCenter = childY + childBox.get_height() / 2;
                scroll = childCenter - adjustment.page_size / 2;
            }

            this.scrollTo(scroll);
        }

        scrollTo(scroll, animate = true, duration = 200) {
            const now = GLib.get_monotonic_time();

            const adjustment = this.vadjustment;
            const anim = this._scrollAnim;

            // Only scroll if the clamped distance is greater than zero to prevent
            // rapidly retriggering the animation while holding down a key
            const min = adjustment.lower;
            const max = adjustment.upper - adjustment.page_size;

            const scrollClamped = Math.clamp(scroll, min, max);
            const distance = Math.abs(this.scroll - scrollClamped);

            if (distance === 0) {
                return Clutter.EVENT_STOP;
            }

            this._scroll = scrollClamped;

            if (animate) {
                // Init scroll animation
                anim.startTime = now;
                anim.startValue = adjustment.value;
                anim.delta = this.scroll - adjustment.value;

                if (anim.lock === null) {
                    anim.lock = global.stage.connect('after-paint', this._scrollAnimationFrame.bind(this));
                    anim.duration = duration * 1000;
                }
            } else {
                // Cancel running animation
                if (anim.lock) {
                    anim.lock = global.stage.disconnect(anim.lock) || null;
                }

                adjustment.value = this.scroll;
            }

            // Redraw to trigger the next animation frame
            this.queue_redraw();

            return Clutter.EVENT_STOP;
        }

        _scrollAnimationFrame() {
            const now = GLib.get_monotonic_time();

            const adjustment = this.vadjustment;
            const anim = this._scrollAnim;

            // Animate towards the scroll target
            const elapsed = now - anim.startTime;
            const progress = Math.clamp(elapsed / anim.duration, 0, 1);

            adjustment.value = anim.startValue + anim.delta * easeOutCubic(progress);

            if (progress >= 1) {
                anim.lock = global.stage.disconnect(anim.lock) || null;
            }

            this.queue_redraw();
        }

        vfunc_scroll_event(event) {
            if (this._settings.get_boolean('animate-scroll')) {
                return this._animateScroll(event);
            }

            return super.vfunc_scroll_event(event);
        }

        _animateScroll(event) {
            const now = GLib.get_monotonic_time();

            // Ignore emulated events
            if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED) {
                return Clutter.EVENT_STOP;
            }

            // Get scroll delta
            const adjustment = this.vadjustment;

            const direction = event.get_scroll_direction();
            const step = adjustment.page_size ** (2 / 3);

            let delta = 0;
            let animate = false;

            if (direction === Clutter.ScrollDirection.SMOOTH) {
                // Sometimes events without a smooth delta are emitted when using a
                // trackpad, so this debounce timestamp is used to prevent any sudden
                // jumps while scrolling
                this._trackpadTime = now;

                delta = event.get_scroll_delta()[Clutter.Orientation.VERTICAL] || 0;
            } else if (now - this._trackpadTime > 1000 * 1000) {
                if (direction === Clutter.ScrollDirection.UP) {
                    delta = -1;
                } else if (direction === Clutter.ScrollDirection.DOWN) {
                    delta = 1;
                }

                animate = true;
            }

            // Animate to the new scroll position
            const min = adjustment.lower;
            const max = adjustment.upper - adjustment.page_size;

            const clampedScroll = Math.clamp(this.scroll + delta * step, min, max);
            const distance = Math.abs(this.scroll - clampedScroll);
            const duration = (distance / 100) * 200;

            if (distance === 0) {
                return Clutter.EVENT_STOP;
            }

            return this.scrollTo(clampedScroll, animate, duration);
        }

        destroy() {
            if (this._scrollAnim.lock) {
                global.stage.disconnect(this._scrollAnim.lock);
            }
            super.destroy();
        }

        get scroll() {
            return this._scroll;
        }
    });

const VerticalLayout = GObject.registerClass(
    class VerticalLayout extends Clutter.LayoutManager {
        _init(settings) {
            super._init();

            this._settings = settings;

            settings.connectObject('changed', (_, key) => {
                if (['columns', 'icon-spacing'].includes(key)) {
                    this._columns = settings.get_int('columns');
                    this._spacing = settings.get_int('icon-spacing');

                    this.layout_changed();
                }
            }, this);

            this._columns = settings.get_int('columns');
            this._spacing = settings.get_int('icon-spacing');
        }

        vfunc_get_preferred_width(container, _forHeight) {
            const children = container.get_children();
            const childSize = this._getMinChildSize(children);

            const columns = Math.min(children.length, this._columns);
            const size = columns * childSize + (columns - 1) * this._spacing;

            if (columns) {
                return [size, size];
            }

            return [0, 0];
        }

        vfunc_get_preferred_height(container, _forWidth) {
            const children = container.get_children();
            const childSize = this._getMinChildSize(children);

            const rows = Math.ceil(children.length / this._columns);
            const size = rows * childSize + (rows - 1) * this._spacing;

            if (rows) {
                return [size, size];
            }

            return [0, 0];
        }

        vfunc_allocate(container, _box) {
            const children = container.get_children();
            const childSize = this._getMinChildSize(children);

            const childBox = new Clutter.ActorBox();

            for (let i = 0; i < children.length; i++) {
                const col = i % this._columns;
                const row = Math.floor(i / this._columns);

                const x = col * (childSize + this._spacing);
                const y = row * (childSize + this._spacing);

                const [, ,
                    naturalWidth, naturalHeight
                ] = children[i].get_preferred_size();

                childBox.set_origin(
                    Math.floor(x),
                    Math.floor(y)
                );

                childBox.set_size(
                    Math.max(childSize, naturalWidth),
                    Math.max(childSize, naturalHeight)
                );

                children[i].allocate(childBox);
            }
        }

        _getMinChildSize(children) {
            let minWidth = 0;
            let minHeight = 0;

            children.forEach(child => {
                const childMinHeight = child.get_preferred_height(-1)[0];
                const childMinWidth = child.get_preferred_width(-1)[0];

                minWidth = Math.max(minWidth, childMinWidth);
                minHeight = Math.max(minHeight, childMinHeight);
            });

            return Math.max(minWidth, minHeight);
        }

        destroy() {
            this._settings.disconnectObject(this);
        }
    });