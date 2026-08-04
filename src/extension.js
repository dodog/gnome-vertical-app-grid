import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppMenu from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

import {
    Extension,
    gettext as _
} from 'resource:///org/gnome/shell/extensions/extension.js';
import {
    InjectionManager
} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    VerticalAppDisplay
} from './appDisplay.js';

// Extension entrypoint: manage lifecycle and UI overrides.
// Integrates the app display into the overview.
export default class VerticalAppGridExtension extends Extension {
    // Called when the extension is enabled. Sets up the custom app grid,
    // attaches it into the overview, and installs Shell overrides.
    enable() {
        const extension = this;
        const overviewControlsProto = OverviewControls.ControlsManager.prototype;

        this._settings = this.getSettings();
        this._vertAppDisplay = new VerticalAppDisplay(this._settings);
        this._injectionManager = new InjectionManager();
        this._overviewShowingId = null;
        this._overviewReadyPollId = null;
        this._dndDisconnected = false;

        this._getOverviewControls = () => Main.overview && Main.overview._overview ? Main.overview._overview._controls : null;

        this._onOverviewReady = () => {
            const attached = this._attachOverviewControls();
            this._setAppDisplayLayout();
            this._installAppDisplayBoxOverride();
            this._updateWorkspacesVisibility();
            return attached;
        };

        // Attach the custom vertical app display into the overview controls when they become available.
        this._attachOverviewControls = () => {
            const controls = this._getOverviewControls();
            if (!controls || !this._vertAppDisplay) {
                return false;
            }

            if (this._vertAppDisplay.get_parent() !== controls) {
                controls.add_child(this._vertAppDisplay);
            }

            this._overviewControls = controls;
            this._overviewLayoutManager = controls.layout_manager;

            return true;
        };

        this._setAppDisplayLayout = () => {
            if (!this._overviewLayoutManager || !this._vertAppDisplay) {
                return;
            }

            this._overviewLayoutManager._appDisplay = this._vertAppDisplay;
        };

        // Reclaim the space GNOME reserves for the "workspace preview" when
        // workspaces are hidden, so the app grid can use more vertical room.
        this._installAppDisplayBoxOverride = () => {
            const controls = this._overviewControls || this._getOverviewControls();
            if (!controls || !controls.layout_manager || this._appDisplayBoxOverrideInstalled) {
                return false;
            }

            const layoutManagerProto = Object.getPrototypeOf(controls.layout_manager);
            this._appDisplayBoxOverrideInstalled = true;

            this._injectionManager.overrideMethod(layoutManagerProto, '_getAppDisplayBoxForState', originalFn => function(state, box, searchHeight, dashHeight, workspacesBox, spacing) {
                if (extension._settings.get_boolean('show-workspaces')) {
                    return originalFn.call(this, state, box, searchHeight, dashHeight, workspacesBox, spacing);
                }

                // Same shape as the stock method, but treat the reserved
                // workspace-preview height as 0 so the app grid gets that space back.
                const [width, height] = box.get_size();
                const {
                    y1: startY
                } = this._workAreaBox;
                const appDisplayBox = new Clutter.ActorBox();

                switch (state) {
                    case OverviewControls.ControlsState.HIDDEN:
                    case OverviewControls.ControlsState.WINDOW_PICKER:
                        appDisplayBox.set_origin(0, box.y2);
                        break;
                    case OverviewControls.ControlsState.APP_GRID:
                        appDisplayBox.set_origin(0, startY + searchHeight + spacing);
                        break;
                }

                appDisplayBox.set_size(width,
                    height - searchHeight - spacing - dashHeight - spacing);

                return appDisplayBox;
            });

            return true;
        };

        // Poll until the overview is fully ready, then attach the UI. This
        // covers the case where the overview is not initialized immediately.
        this._startOverviewReadyPoll = () => {
            if (this._overviewReadyPollId !== null) {
                return;
            }

            this._overviewReadyPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                if (this._onOverviewReady()) {
                    this._overviewReadyPollId = null;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        };

        this._stopOverviewReadyPoll = () => {
            if (this._overviewReadyPollId !== null) {
                GLib.Source.remove(this._overviewReadyPollId);
                this._overviewReadyPollId = null;
            }
        };

        // Ensure we listen for the overview showing signal so we can attach the
        // app display later if it was not ready at enable().
        this._ensureOverviewConnections = () => {
            if (!Main.overview || this._overviewShowingId !== null) {
                return;
            }

            this._overviewShowingId = Main.overview.connect('showing', () => {
                this._onOverviewReady();
            });
        };

        // Apply workspace visibility preference. Show or hide the workspace
        // preview panel based on the extension setting, and force a layout
        // refresh if needed.
        this._updateWorkspacesVisibility = (forceShow = false) => {
            const show = forceShow || this._settings.get_boolean('show-workspaces');
            const controls = this._overviewControls || this._getOverviewControls();

            if (!controls) {
                this._ensureOverviewConnections();
                return;
            }

            this._overviewControls = controls;
            const workspaceDisplay = controls._workspacesDisplay;

            if (!workspaceDisplay) {
                // Controls exist but haven't finished constructing yet; retry.
                this._ensureOverviewConnections();
                return;
            }

            if (show) {
                workspaceDisplay.show();
            } else {
                workspaceDisplay.hide();
            }

            if (controls.layout_manager) {
                controls.layout_manager.layout_changed();
            }
            controls.queue_relayout();

            const parent = controls.get_parent();
            if (parent && parent.layout_manager) {
                parent.layout_manager.layout_changed();
            }
            if (parent) {
                parent.queue_relayout();
            }
        };

        const ViewPage = {
            WINDOWS: 0,
            APPS: 1,
            SEARCH: 2
        };

        // _onOverviewReady() already calls _attachOverviewControls(),
        // _setAppDisplayLayout(), and _installAppDisplayBoxOverride()
        this._ensureOverviewConnections();
        this._onOverviewReady();
        this._startOverviewReadyPoll();

        this._injectionManager.overrideMethod(overviewControlsProto, '_setVisibility', originalFn => function() {
            if (!extension._settings.get_boolean('show-workspaces')) {
                const activePage = this._searchController.searchActive ? ViewPage.SEARCH :
                    (this._appDisplay.visible ? ViewPage.APPS : ViewPage.WINDOWS);
                const dashVisible = activePage === ViewPage.WINDOWS || activePage === ViewPage.APPS;
                const thumbnailsVisible = false;

                if (dashVisible) {
                    this._dashSlider.slideIn();
                } else {
                    this._dashSlider.slideOut();
                }

                if (thumbnailsVisible) {
                    this._thumbnailsSlider.slideIn();
                } else {
                    this._thumbnailsSlider.slideOut();
                }

                if (this._dashSpacer) {
                    this._dashSpacer.visible = activePage === ViewPage.WINDOWS;
                }

                return;
            }

            originalFn.call(this);
        });

        // Now that controls are set up, connect the settings signal and apply initial state
        this._settingsSignal = this._settings.connect('changed::show-workspaces', () => this._updateWorkspacesVisibility());
        this._updateWorkspacesVisibility();

        this._injectionManager.overrideMethod(overviewControlsProto, '_updateAppDisplayVisibility', () => function(params = null) {
            if (!params) {
                params = this._stateAdjustment.getStateTransitionParams();
            }

            const {
                initialState,
                finalState
            } = params;
            const state = Math.max(initialState, finalState);

            extension._vertAppDisplay.visible =
                state > OverviewControls.ControlsState.WINDOW_PICKER &&
                !this._searchController.searchActive;

            // Focus the vertical app display
            if (extension._vertAppDisplay.visible) {
                global.stage.set_key_focus(extension._vertAppDisplay);
            }

            // Disable drag and drop on the original app grid to prevent
            // internal errors when rearranging app icons in the dash. This
            // fires on every state-transition tick (effectively every
            // animation frame while the overview is transitioning), so
            // guard it to only actually run once per enable() cycle rather
            // than repeatedly calling into the stock app display's DnD
            // teardown for no reason on every frame.
            if (!extension._dndDisconnected) {
                extension._overviewControls.appDisplay._disconnectDnD();
                extension._dndDisconnected = true;
            }
        });

        // Fade out the app display when the search becomes active
        this._injectionManager.overrideMethod(overviewControlsProto, '_onSearchChanged', originalFn => function() {
            originalFn.call(this);

            const {
                searchActive
            } = this._searchController;

            extension._vertAppDisplay.ease({
                opacity: searchActive ? 0 : 255,
                duration: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
        });

        // Rename the "Pin to Dash" item in the app menu
        this._injectionManager.overrideMethod(AppMenu.AppMenu.prototype, '_updateFavoriteItem', originalFn => function() {
            originalFn.call(this);

            if (this._toggleFavoriteItem.visible) {
                const text = this._appFavorites.isFavorite(this._app.id) ?
                    _('Remove from Favorites') :
                    _('Add to Favorites');

                this._toggleFavoriteItem.label.text = text;
            }
        });
    }

    // Cleanup all injected state and restore original Shell behavior.
    disable() {
        if (this._overviewReadyPollId !== null) {
            GLib.Source.remove(this._overviewReadyPollId);
            this._overviewReadyPollId = null;
        }

        try {
            if (this._overviewLayoutManager && this._overviewControls) {
                this._overviewLayoutManager._appDisplay = this._overviewControls.appDisplay;
            }

            if (this._overviewControls && this._vertAppDisplay) {
                this._overviewControls.remove_child(this._vertAppDisplay);
            }

            if (this._injectionManager) {
                this._injectionManager.clear();
            }

            if (this._vertAppDisplay) {
                this._vertAppDisplay.destroy();
            }

            if (this._overviewControls && this._overviewControls.appDisplay) {
                this._overviewControls.appDisplay._disconnectDnD();
                this._overviewControls.appDisplay._connectDnD();
            }
        } catch (e) {
            console.debug(`vertigrid: Error during core teardown: ${e}`);
        }

        // Disconnect settings signal and restore workspace visibility before clearing
        if (this._settingsSignal && this._settings) {
            this._settings.disconnect(this._settingsSignal);
            this._settingsSignal = null;
        }

        if (this._overviewShowingId !== null && Main.overview) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = null;
        }

        this._stopOverviewReadyPoll();

        // Restore workspace visibility when disabling - forceShow=true so
        // this actually restores them regardless of the current show-workspaces setting.
        if (this._updateWorkspacesVisibility) {
            this._updateWorkspacesVisibility(true);
        }

        // Reset so a subsequent enable() (GNOME Shell reuses this same
        // Extension instance across disable()/enable() cycles, it doesn't
        // create a fresh one) can reinstall the workspace-preview-box
        // override instead of silently skipping it because this flag was
        // still true from the previous enable().
        this._appDisplayBoxOverrideInstalled = false;
        this._dndDisconnected = false;

        this._settings = null;
        this._vertAppDisplay = null;
        this._injectionManager = null;
        this._overviewControls = null;
        this._overviewLayoutManager = null;
    }
}
