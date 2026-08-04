import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    DEFAULT_CATEGORIES,
    getSettingsString
} from './categories.js';

import {
    ExtensionPreferences,
    gettext as _
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Preferences UI for editing extension settings and custom categories.
export default class VertiGridPreferences extends ExtensionPreferences {
    // Construct the preferences UI and wire widgets to the extension settings.
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const builder = new Gtk.Builder();

        // Load the UI file
        builder.add_from_file(`${this.path}/prefs.ui`);

        // Two tabs: general app-grid settings, and the custom categories editor 
        const appGridPage = builder.get_object('app-grid-page');
        const customCategoriesPage = builder.get_object('custom-categories-page');

        window.add(appGridPage);
        window.add(customCategoriesPage);

        // Bind the UI to the settings
        const properties = [
            ['animate-scroll', 'active'],
            ['columns', 'value'],
            ['favorites-section', 'active'],
            ['show-favorites-in-app-grid', 'active'],
            ['category-grouping', 'active'],
            ['icon-size', 'value'],
            ['icon-spacing', 'value'],
            ['category-font-size', 'value'],
            ['show-workspaces', 'active'],
            ['always-show-category-nav', 'active'],
            ['clip-app-labels', 'active']
        ];

        properties.forEach(([key, property]) => {
            settings.bind(key, builder.get_object(key), property, Gio.SettingsBindFlags.DEFAULT);
        });

        this._bindComboRow(builder, settings, 'app-sorting', ['usage', 'alphabetical']);
        this._bindComboRow(builder, settings, 'favorites-sorting', ['dash', 'usage', 'alphabetical']);

        // Populate the "Custom Categories" tab with the editor UI.
        this._buildCustomCategoriesTab(builder, window, settings);
    }

    // Build the custom categories editor directly into the
    // "custom-categories-group" placeholder on the Custom Categories tab
    _buildCustomCategoriesTab(builder, window, settings) {
        const group = builder.get_object('custom-categories-group');
        if (!group) {
            return;
        }

        const outerBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_top: 6,
            margin_bottom: 6
        });

        // Add/Save row goes at the top under the group's intro text
        const buttonRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8
        });
        outerBox.append(buttonRow);

        const addCategoryBtn = new Gtk.Button({
            label: _('Add category'),
            icon_name: 'list-add-symbolic',
            halign: Gtk.Align.START
        });
        buttonRow.append(addCategoryBtn);

        const buttonRowSpacer = new Gtk.Box({
            hexpand: true
        });
        buttonRow.append(buttonRowSpacer);

        const saveBtn = new Gtk.Button({
            label: _('Save Custom Categories'),
            halign: Gtk.Align.END
        });
        saveBtn.add_css_class('suggested-action');
        buttonRow.append(saveBtn);

        const errorLabel = new Gtk.Label({
            xalign: 0,
            wrap: true,
            visible: false
        });
        errorLabel.add_css_class('error');
        outerBox.append(errorLabel);


        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE
        });
        listBox.add_css_class('boxed-list');
        outerBox.append(listBox);

        // Each row's live widgets, so we can read their current values on Save.
        const rows = [];

        const addRow = (name = '', enabled = true, merge = false, isDefault = false, insertAtTop = false, order = null, icon = null) => {
            const row = new Gtk.ListBoxRow({
                activatable: false
            });

            const rowBox = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 6,
                margin_top: 10,
                margin_bottom: 10,
                margin_start: 10,
                margin_end: 10
            });
            row.set_child(rowBox);

            // Line 1: category name + enabled switch + remove button
            const topLine = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8
            });
            rowBox.append(topLine);

            const nameEntry = new Gtk.Entry({
                hexpand: true,
                placeholder_text: _('Category name (e.g. Fonts)'),
                text: isDefault ? _(name) : name,
                editable: !isDefault,
                can_focus: !isDefault
            });
            if (isDefault) {
                nameEntry.add_css_class('dim-label');
            }
            topLine.append(nameEntry);

            const enabledLabel = new Gtk.Label({
                label: _('Enabled')
            });
            topLine.append(enabledLabel);

            const enabledSwitch = new Gtk.Switch({
                active: Boolean(enabled),
                valign: Gtk.Align.CENTER
            });
            topLine.append(enabledSwitch);

            let removeBtn = null;
            if (!isDefault) {
                removeBtn = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER
                });
                removeBtn.add_css_class('flat');
                topLine.append(removeBtn);
            } else {
                // Built-in categories can be disabled or merged, but not
                // removed from the list entirely.
                const defaultBadge = new Gtk.Label({
                    label: _('Built-in'),
                    valign: Gtk.Align.CENTER
                });
                defaultBadge.add_css_class('dim-label');
                topLine.append(defaultBadge);
            }

            // Line 2: merge target
            const bottomLine = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8
            });
            rowBox.append(bottomLine);

            const mergeCheck = new Gtk.CheckButton({
                label: _('Merge into another category'),
                active: Boolean(merge)
            });
            bottomLine.append(mergeCheck);

            const mergeEntry = new Gtk.Entry({
                hexpand: true,
                placeholder_text: _('Target category name (e.g. Webdesign)'),
                text: merge ? String(merge) : '',
                sensitive: Boolean(merge)
            });
            bottomLine.append(mergeEntry);

            mergeCheck.connect('toggled', () => {
                mergeEntry.sensitive = mergeCheck.active;
                if (!mergeCheck.active) {
                    mergeEntry.set_text('');
                }
            });

            // Line 3: custom sort order (applies to built-in and custom
            // categories alike, and interleaves with everything else once set —
            // categories without a custom order keep their normal position).
            const orderLine = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8
            });
            rowBox.append(orderLine);

            const hasOrder = order !== null && order !== undefined && Number.isFinite(Number(order));

            const orderCheck = new Gtk.CheckButton({
                label: _('Custom order'),
                active: hasOrder
            });
            orderLine.append(orderCheck);

            const orderSpin = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({
                    lower: -1000,
                    upper: 1000,
                    step_increment: 1,
                    page_increment: 10
                }),
                value: hasOrder ? Number(order) : 0,
                sensitive: hasOrder,
                valign: Gtk.Align.CENTER
            });
            orderLine.append(orderSpin);

            const orderHint = new Gtk.Label({
                label: _('Lower numbers appear first'),
                sensitive: hasOrder
            });
            orderHint.add_css_class('dim-label');
            orderLine.append(orderHint);

            orderCheck.connect('toggled', () => {
                orderSpin.sensitive = orderCheck.active;
                orderHint.sensitive = orderCheck.active;
            });

            // Line 4: custom icon, shown for both built-in categories (to
            // override an icon that might not exist in the user's icon
            // theme) and custom ones (which otherwise start with a generic
            // placeholder icon).
            const iconLine = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8
            });
            rowBox.append(iconLine);

            const iconState = {
                value: icon || null
            };

            const iconPreview = new Gtk.Image({
                icon_name: iconState.value || 'image-missing-symbolic',
                pixel_size: 18,
                valign: Gtk.Align.CENTER
            });
            iconLine.append(iconPreview);

            const iconLabel = new Gtk.Label({
                label: iconState.value || _('Default icon'),
                hexpand: true,
                xalign: 0,
                valign: Gtk.Align.CENTER
            });
            iconLabel.add_css_class('dim-label');
            iconLine.append(iconLabel);

            const chooseIconBtn = new Gtk.Button({
                label: _('Choose Icon\u2026'),
                valign: Gtk.Align.CENTER
            });
            iconLine.append(chooseIconBtn);

            chooseIconBtn.connect('clicked', () => {
                this._openIconChooser(window, iconState.value, selected => {
                    iconState.value = selected;
                    iconPreview.set_from_icon_name(selected || 'image-missing-symbolic');
                    iconLabel.set_text(selected || _('Default icon'));
                });
            });

            const rowEntry = {
                nameEntry,
                enabledSwitch,
                mergeCheck,
                mergeEntry,
                orderCheck,
                orderSpin,
                iconState,
                isDefault,
                canonicalName: name
            };
            rows.push(rowEntry);

            if (removeBtn) {
                removeBtn.connect('clicked', () => {
                    const idx = rows.indexOf(rowEntry);
                    if (idx >= 0) {
                        rows.splice(idx, 1);
                    }
                    listBox.remove(row);
                });
            }

            if (insertAtTop) {
                listBox.insert(row, 0);
            } else {
                listBox.append(row);
            }
            return rowEntry;
        };

        // Populate custom categories first, then a separator, then the
        // built-in categories below it.
        const existing = this._loadExistingCategories(settings);
        const customCategories = existing.filter(c => !c.isDefault);
        const defaultCategories = existing.filter(c => c.isDefault);

        for (const category of customCategories) {
            addRow(category.name, category.enabled, category.merge, category.isDefault, false, category.order, category.icon);
        }

        const separatorRow = new Gtk.ListBoxRow({
            activatable: false,
            selectable: false
        });
        const separatorBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 8,
            margin_bottom: 4
        });
        separatorBox.append(new Gtk.Separator({
            orientation: Gtk.Orientation.HORIZONTAL
        }));
        const separatorLabel = new Gtk.Label({
            label: _('Default categories'),
            halign: Gtk.Align.CENTER,
            margin_top: 4
        });
        separatorLabel.add_css_class('dim-label');
        separatorLabel.add_css_class('caption-heading');
        separatorBox.append(separatorLabel);
        separatorRow.set_child(separatorBox);
        listBox.append(separatorRow);

        for (const category of defaultCategories) {
            addRow(category.name, category.enabled, category.merge, category.isDefault, false, category.order, category.icon);
        }

        // Scroll to the top
        addCategoryBtn.connect('clicked', () => {
            const rowEntry = addRow('', true, false, false, true);
            rowEntry.nameEntry.grab_focus();
        });

        saveBtn.connect('clicked', () => {
            const {
                categories,
                errorMessage
            } = this._collectCategories(rows);

            if (errorMessage) {
                errorLabel.set_text(errorMessage);
                errorLabel.visible = true;
                return;
            }

            errorLabel.visible = false;

            try {
                settings.set_string('custom-categories', JSON.stringify(categories));
                this._showSavedNotice(window);
            } catch (e) {
                errorLabel.set_text(_('Failed to save custom categories: ') + e.message);
                errorLabel.visible = true;
            }
        });

        group.add(outerBox);
    }

    _showSavedNotice(window) {
        const noticeDialog = new Gtk.Dialog({
            transient_for: window,
            modal: true,
            title: _('Custom Categories Saved'),
            default_width: 420,
            use_header_bar: false
        });

        const okBtn = noticeDialog.add_button(_('OK'), Gtk.ResponseType.OK);
        okBtn.add_css_class('suggested-action');
        noticeDialog.set_default_response(Gtk.ResponseType.OK);

        const contentArea = noticeDialog.get_content_area();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_top: 16,
            margin_bottom: 16,
            margin_start: 16,
            margin_end: 16
        });
        contentArea.append(box);

        const icon = new Gtk.Image({
            icon_name: 'dialog-information-symbolic',
            pixel_size: 32,
            halign: Gtk.Align.CENTER
        });
        box.append(icon);

        const label = new Gtk.Label({
            xalign: 0.5,
            wrap: true,
            justify: Gtk.Justification.CENTER,
            label: _('Your custom category settings have been \nsaved and applied to the app grid.')
        });
        box.append(label);

        noticeDialog.connect('response', () => {
            noticeDialog.destroy();
        });

        noticeDialog.present();
    }

    // Opens a searchable picker over the current icon theme's symbolic
    // icons and calls onSelect(iconName) with the chosen icon, or
    // onSelect(null) if the user picks "Use Default Icon" instead.
    // Nothing is called if the dialog is simply cancelled/closed.
    _openIconChooser(window, currentIcon, onSelect) {
        const dialog = new Gtk.Dialog({
            transient_for: window,
            modal: true,
            title: _('Choose an Icon'),
            default_width: 480,
            default_height: 520,
            use_header_bar: true
        });

        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        dialog.add_button(_('Use Default Icon'), Gtk.ResponseType.REJECT);

        const contentArea = dialog.get_content_area();

        const searchEntry = new Gtk.SearchEntry({
            placeholder_text: _('Search symbolic icons (e.g. mail, folder, web)\u2026'),
            margin_top: 8,
            margin_start: 8,
            margin_end: 8
        });
        contentArea.append(searchEntry);

        const scrolled = new Gtk.ScrolledWindow({
            vexpand: true,
            hexpand: true,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 8,
            margin_end: 8
        });
        contentArea.append(scrolled);

        const flowBox = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: 8,
            row_spacing: 4,
            column_spacing: 4,
            homogeneous: true,
            valign: Gtk.Align.START
        });
        scrolled.set_child(flowBox);

        const hintLabel = new Gtk.Label({
            label: _('Start typing to search your system\u2019s symbolic icons.'),
            margin_top: 24
        });
        hintLabel.add_css_class('dim-label');

        // The full icon-name list is read once up front, but matching results only get turned into actual
        // FlowBoxChild/Image widgets on demand as the user types, and
        // capped, so opening the dialog or searching a common substring
        // never has to build thousands of icon widgets at once.
        const iconTheme = Gtk.IconTheme.get_for_display(window.get_display());
        const allIconNames = iconTheme.get_icon_names()
            .filter(iconName => iconName.endsWith('-symbolic'))
            .sort();

        const MAX_RESULTS = 200;

        const populate = query => {
            let child = flowBox.get_first_child();
            while (child) {
                const next = child.get_next_sibling();
                flowBox.remove(child);
                child = next;
            }

            const needle = query.trim().toLowerCase();
            if (!needle) {
                if (scrolled.get_child() !== hintLabel) {
                    scrolled.set_child(hintLabel);
                }
                return;
            }

            if (scrolled.get_child() !== flowBox) {
                scrolled.set_child(flowBox);
            }

            let count = 0;
            for (const iconName of allIconNames) {
                if (!iconName.toLowerCase().includes(needle)) {
                    continue;
                }

                const button = new Gtk.Button({
                    tooltip_text: iconName
                });
                button.add_css_class('flat');
                button.set_child(new Gtk.Image({
                    icon_name: iconName,
                    pixel_size: 24
                }));
                button.connect('clicked', () => {
                    onSelect(iconName);
                    dialog.destroy();
                });

                flowBox.append(button);

                count++;
                if (count >= MAX_RESULTS) {
                    break;
                }
            }
        };

        searchEntry.connect('search-changed', () => {
            populate(searchEntry.get_text());
        });

        populate(currentIcon || '');
        if (currentIcon) {
            searchEntry.set_text(currentIcon);
        }

        dialog.connect('response', (_dlg, response) => {
            if (response === Gtk.ResponseType.REJECT) {
                onSelect(null);
            }
            dialog.destroy();
        });

        dialog.present();
        searchEntry.grab_focus();
    }

    // Validate and serialize the custom category rows before saving them.
    _collectCategories(rows) {
        // Save order is independent of the editor's visual order (customs
        // shown on top, defaults below): built-ins are always written
        // first, in their original order, then customs after. This keeps
        // the app grid's actual category ordering stable regardless of how
        // the editor happens to lay rows out on screen.
        const defaultRows = rows.filter(r => r.isDefault);
        const customRows = rows.filter(r => !r.isDefault);
        const orderedRows = [...defaultRows, ...customRows];

        const categories = [];
        const seenNames = new Set();

        for (const rowEntry of orderedRows) {
            const name = rowEntry.isDefault ?
                rowEntry.canonicalName :
                rowEntry.nameEntry.get_text().trim();
            if (!name) {
                // Skip empty rows silently instead of erroring, so users
                // can add a blank row and just leave it unused.
                continue;
            }

            // Category names are stored (and matched against app-category
            // overrides) using "appId::category::index"-style encoding, so
            // a name containing "::" would corrupt that encoding when an
            // app gets dragged into it - reject it up front instead.
            if (name.includes('::')) {
                return {
                    categories: [],
                    errorMessage: _('Category name cannot contain "::": ') + name
                };
            }

            const key = name.toLowerCase();
            if (seenNames.has(key)) {
                return {
                    categories: [],
                    errorMessage: _('Duplicate category name: ') + name
                };
            }
            seenNames.add(key);

            const enabled = rowEntry.enabledSwitch.get_active();
            const mergeEnabled = rowEntry.mergeCheck.get_active();
            const mergeTarget = rowEntry.mergeEntry.get_text().trim();

            let merge = false;
            if (mergeEnabled) {
                if (!mergeTarget) {
                    return {
                        categories: [],
                        errorMessage: _('Enter a target category to merge "') + name + _('" into, or uncheck "Merge into another category".')
                    };
                }

                if (mergeTarget.includes('::')) {
                    return {
                        categories: [],
                        errorMessage: _('Merge target cannot contain "::": ') + mergeTarget
                    };
                }

                merge = mergeTarget;
            }

            const category = {
                name,
                enabled,
                merge
            };

            if (rowEntry.orderCheck.get_active()) {
                category.order = rowEntry.orderSpin.get_value_as_int();
            }

            if (rowEntry.iconState.value) {
                category.icon = rowEntry.iconState.value;
            }

            categories.push(category);
        }

        return {
            categories,
            errorMessage: null
        };
    }

    // Load the built-in and stored categories for the category editor.
    _loadExistingCategories(settings) {
        // Start from the built-in defaults so the user can see and edit
        // (enable/disable, merge) the standard categories too, not just ones he added.
        const merged = DEFAULT_CATEGORIES.map(c => ({
            name: c.name,
            enabled: Object.hasOwn(c, 'enabled') ? Boolean(c.enabled) : true,
            merge: (c.merge && c.merge !== false) ? String(c.merge) : false,
            order: null,
            icon: null,
            isDefault: true
        }));

        const raw = getSettingsString(settings, 'custom-categories', '[]');
        let stored = [];
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                stored = parsed
                    .filter(c => c && typeof c === 'object' && c.name)
                    .map(c => {
                        const orderValue = Number(c.order);
                        return {
                            name: String(c.name),
                            enabled: Object.hasOwn(c, 'enabled') ? Boolean(c.enabled) : true,
                            merge: (c.merge && c.merge !== false) ? String(c.merge) : false,
                            order: Number.isFinite(orderValue) ? orderValue : null,
                            icon: c.icon ? String(c.icon) : null,
                            isDefault: false
                        };
                    });
            }
        } catch (e) {
            console.debug(`vertigrid: Failed to parse custom categories: ${e}`);
        }

        // Any stored entry overrides a default with the same name
        // (case-insensitive), or gets appended as an extra custom category.
        for (const category of stored) {
            const key = category.name.toLowerCase();
            const existingIndex = merged.findIndex(c => c.name.toLowerCase() === key);
            if (existingIndex >= 0) {
                // Keep the built-in's own canonical-cased name rather than
                // whatever casing the stored override happens to use (only
                // reachable via manual GSettings edits outside this UI,
                // since the editor itself always round-trips the canonical
                // name for built-in rows) - a mismatched casing here would
                // make the _(name) gettext lookup for the row label
                // silently miss its translation.
                merged[existingIndex] = {
                    ...category,
                    name: merged[existingIndex].name,
                    isDefault: true
                };
            } else {
                merged.push(category);
            }
        }

        return merged;
    }

    // Bind a combo row to a string setting and keep the saved value in sync.
    _bindComboRow(builder, settings, key, values) {
        const comboRow = builder.get_object(key);

        comboRow.connect('notify::selected', () => {
            settings.set_string(key, values[comboRow.selected]);
        });

        // Falls back to the first option if the stored value doesn't match
        // any known one (e.g. leftover from an older extension version, or
        // a corrupted config) - indexOf returning -1 would otherwise be
        // passed straight through to set_selected() with no valid row
        // selected at all.
        const index = values.indexOf(settings.get_string(key));
        comboRow.set_selected(index >= 0 ? index : 0);
    }
}