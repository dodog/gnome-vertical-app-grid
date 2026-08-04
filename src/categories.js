/*
Category config and custom category storage helpers.
Custom categories are saved under 'custom-categories' and survive updates.
*/

// Marks a string for translation extraction (xgettext) without translating
// it here. These are internal category IDs (also matched against .desktop
// Categories= keys), so they must stay untranslated at this point - the
// actual translation happens later, at display time, via _(category.name)
// in appDisplay.js and prefs.js.
const N_ = s => s;

// Settings helpers and category utilities used by the extension and prefs.
// Safe/settings helper functions used by the extension and preferences UI.
export function getSettingsString(settings, key, fallback = '') {
    if (!settings) {
        return fallback;
    }

    try {
        return settings.get_string(key) || fallback;
    } catch (e) {
        console.debug(`vertigrid: Failed to read ${key}: ${e}`);
        return fallback;
    }
}

export function getSettingsStrv(settings, key, fallback = []) {
    if (!settings) {
        return fallback;
    }

    try {
        return settings.get_strv(key) || fallback;
    } catch (e) {
        console.debug(`vertigrid: Failed to read ${key}: ${e}`);
        return fallback;
    }
}

// Built-in default categories shown when no custom categories are set.
// Names are wrapped in N_() purely so xgettext extracts them into the
// .pot file; N_() is an identity function, so DEFAULT_CATEGORIES[i].name
// is still the plain, untranslated string (e.g. 'Development') used
// internally for matching/storage/config. Translation happens later, at
// display time, wherever _(category.name) is called.
export const DEFAULT_CATEGORIES = [{
        name: N_('Development'),
        enabled: true,
        merge: false
    },
    {
        name: N_('Office'),
        enabled: true,
        merge: false
    },
    {
        name: N_('Network'),
        enabled: true,
        merge: false
    },
    {
        name: N_('AudioVideo'),
        enabled: false,
        merge: false
    },
    {
        name: N_('Audio'),
        enabled: true,
        merge: false
    },
    {
        name: N_('Video'),
        enabled: true,
        merge: false
    },
    {
        name: N_('Graphics'),
        enabled: true,
        merge: false
    },
    {
        name: N_('Education'),
        enabled: true,
        merge: false
    },
    {
        name: N_('Game'),
        enabled: true,
        merge: false
    },
    {
        name: N_('Utility'),
        enabled: true,
        merge: false
    },
    {
        name: N_('Accessories'),
        enabled: true,
        merge: false
    },
    {
        name: N_('System'),
        enabled: true,
        merge: false
    },
    {
        name: N_('Settings'),
        enabled: true,
        merge: false
    }
];

// Normalize stored or user-provided category objects to a consistent shape
// before they are merged with defaults and displayed.
function _normalizeCategory(category, defaultOrder) {
    if (!category || typeof category !== 'object') {
        return null;
    }

    const name = category.name ? String(category.name).trim() : '';
    if (!name) {
        return null;
    }

    let enabled = true;
    if (Object.hasOwn(category, 'enabled')) {
        enabled = Boolean(category.enabled);
    }

    let merge = false;
    if (Object.hasOwn(category, 'merge')) {
        if (category.merge === false || category.merge === null) {
            merge = false;
        } else {
            merge = String(category.merge).trim();
            if (merge === '') {
                merge = false;
            }
        }
    }

    const orderValue = Number(category.order);
    const order = Number.isFinite(orderValue) ? orderValue : null;

    let icon = null;
    if (Object.hasOwn(category, 'icon')) {
        const trimmedIcon = category.icon ? String(category.icon).trim() : '';
        icon = trimmedIcon || null;
    }

    return {
        name,
        enabled,
        merge,
        order,
        icon,
        _defaultOrder: defaultOrder
    };
}

// Read the saved custom categories JSON from settings and normalize it.
function _loadCustomCategories(settings) {
    const raw = getSettingsString(settings, 'custom-categories', '[]');
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed
            .map((category, index) => _normalizeCategory(category, DEFAULT_CATEGORIES.length + index))
            .filter(Boolean);
    } catch (e) {
        console.debug(`vertigrid: Failed to parse custom categories: ${e}`);
        return [];
    }
}

function _categoryNamesEqual(a, b) {
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// Build the effective category list by merging built-in defaults with any
// custom category overrides stored in settings.
export function getCategories(settings) {
    const categories = DEFAULT_CATEGORIES.map((category, index) => ({
        ...category,
        order: null,
        icon: null,
        _defaultOrder: index
    }));

    const customCategories = _loadCustomCategories(settings);
    for (const customCategory of customCategories) {
        const existingIndex = categories.findIndex(category => _categoryNamesEqual(category.name, customCategory.name));
        if (existingIndex >= 0) {
            categories[existingIndex] = {
                ...categories[existingIndex],
                ...customCategory
            };
        } else {
            categories.push(customCategory);
        }
    }

    categories.sort((a, b) => {
        const aOrder = Number.isFinite(a.order) ? a.order : a._defaultOrder;
        const bOrder = Number.isFinite(b.order) ? b.order : b._defaultOrder;
        return aOrder - bOrder;
    });

    return categories;
}

export function getCategoryOrder(settings) {
    return getCategories(settings)
        .filter(cat => cat.enabled && !cat.merge)
        .map(cat => cat.name);
}

export function getAllCategories(settings) {
    return [...getCategories(settings).map(cat => cat.name), 'Other'];
}

// Returns Map category name -> icon name, containing only categories that
// have an explicit custom icon set (via a custom-categories entry, either
// a new category or one overriding a default's icon). Categories with no
// entry here should fall back to their own built-in default icon.
export function getCategoryIconMap(settings) {
    const map = new Map();
    for (const category of getCategories(settings)) {
        if (category.icon) {
            map.set(category.name, category.icon);
        }
    }
    return map;
}

// app-category-overrides use appId::category::index encoding. These helpers
// centralize parse/format logic.
function _encodeOverrideEntry(appId, category, index) {
    if (index !== null && index !== undefined) {
        return `${appId}::${category}::${Math.floor(index)}`;
    }
    return `${appId}::${category}`;
}

function _parseOverrideEntry(entry) {
    const parts = entry.split('::');
    if (parts.length < 2) {
        return null;
    }

    const id = parts[0];
    const category = parts[1];
    const parsedIndex = parts.length >= 3 ? parseInt(parts[2], 10) : null;

    return {
        id,
        category,
        index: Number.isFinite(parsedIndex) ? parsedIndex : null
    };
}

function _removeOverrideEntriesForApp(arr, appId) {
    return arr.filter(e => !e.startsWith(appId + '::'));
}

function _loadOverrides(settings) {
    const arr = getSettingsStrv(settings, 'app-category-overrides', []);
    // Map of appId -> { category: string, index: number|null }
    const map = new Map();
    for (const entry of arr) {
        const parsed = _parseOverrideEntry(entry);
        if (!parsed) {
            continue;
        }
        map.set(parsed.id, {
            category: parsed.category,
            index: parsed.index
        });
    }
    return map;
}

export function setAppCategory(settings, appId, category, index = null) {
    if (!settings) {
        return false;
    }

    try {
        const arr = settings.get_strv('app-category-overrides') || [];
        const overrides = arr
            .map(_parseOverrideEntry)
            .filter(Boolean)
            .filter(entry => entry.id !== appId);

        if (!category || category === 'Other') {
            settings.set_strv('app-category-overrides', overrides.map(entry => _encodeOverrideEntry(entry.id, entry.category, entry.index)));
            return true;
        }

        const numericIndex = Number.isFinite(Number(index)) ? Number(index) : null;
        const target = overrides
            .filter(entry => entry.category === category && entry.index !== null)
            .sort((a, b) => a.index - b.index);
        const others = overrides.filter(entry => entry.category !== category || entry.index === null);

        const result = [...others];
        if (numericIndex === null) {
            result.push({
                id: appId,
                category,
                index: null
            });
        } else {
            const insertPos = Math.max(0, Math.min(numericIndex, target.length));
            const ordered = [];

            for (let i = 0; i < insertPos; i++) {
                ordered.push({
                    id: target[i].id,
                    category,
                    index: i
                });
            }
            ordered.push({
                id: appId,
                category,
                index: insertPos
            });
            for (let i = insertPos; i < target.length; i++) {
                ordered.push({
                    id: target[i].id,
                    category,
                    index: i + 1
                });
            }

            result.push(...ordered);
        }

        settings.set_strv('app-category-overrides', result.map(entry => _encodeOverrideEntry(entry.id, entry.category, entry.index)));
        return true;
    } catch (e) {
        console.debug(`vertigrid: Failed to set app category override: ${e}`);
        return false;
    }
}

export function clearAppCategory(settings, appId) {
    if (!settings) {
        return false;
    }

    try {
        const arr = settings.get_strv('app-category-overrides') || [];
        const filtered = _removeOverrideEntriesForApp(arr, appId);
        settings.set_strv('app-category-overrides', filtered);
        return true;
    } catch (e) {
        console.debug(`vertigrid: Failed to clear app category override: ${e}`);
        return false;
    }
}

/**
 * Write explicit indexes for every app in a category so the order is
 * consistent after drag-and-drop reordering.
 */
export function setCategoryOrder(settings, category, orderedAppIds) {
    if (!settings) {
        return false;
    }

    try {
        const arr = settings.get_strv('app-category-overrides') || [];
        const reindexedIds = new Set(orderedAppIds);

        // Drop any existing entry (in ANY category) for every id that's
        // getting a fresh, authoritative placement below.
        const overrides = arr
            .map(_parseOverrideEntry)
            .filter(Boolean)
            .filter(entry => !reindexedIds.has(entry.id));

        // Write an explicit index for every app, including ones landing in
        // 'Other'. 'Other' isn't a real configured category (it's never
        // in currentCategories in getAppCategory() below), so an override
        // entry here can only ever supply ordering metadata for the Other
        // bucket - it can't accidentally "pin" an app there the way an
        // override for a real category name would, so there's no downside
        // to always persisting it. This also allows apps to be reordered
        // within Other via drag-and-drop, same as any other category.
        orderedAppIds.forEach((appId, index) => {
            overrides.push({
                id: appId,
                category,
                index
            });
        });

        settings.set_strv('app-category-overrides', overrides.map(entry => _encodeOverrideEntry(entry.id, entry.category, entry.index)));
        return true;
    } catch (e) {
        console.debug(`vertigrid: Failed to set category order: ${e}`);
        return false;
    }
}

export function getCategoryOrderMap(settings) {
    // Returns Map category -> array of appIds sorted by index (asc)
    const overrides = getSettingsStrv(settings, 'app-category-overrides', []);
    const buckets = new Map();
    for (const entry of overrides) {
        const parsed = _parseOverrideEntry(entry);
        if (!parsed || parsed.index === null) {
            continue;
        }
        if (!buckets.has(parsed.category)) {
            buckets.set(parsed.category, []);
        }
        buckets.get(parsed.category).push({
            id: parsed.id,
            index: parsed.index
        });
    }
    const result = new Map();
    for (const [cat, arr] of buckets) {
        arr.sort((a, b) => a.index - b.index);
        result.set(cat, arr.map(x => x.id));
    }
    return result;
}

function _isValidTargetCategory(currentCategories, name) {
    // Only return enabled, non-merged categories to avoid invalid buckets.
    return currentCategories.some(c =>
        c.enabled && !c.merge && _categoryNamesEqual(c.name, name)
    );
}

/**
 * Precompute the pieces getAppCategory() needs - the merged category list
 * and the override map - once. A caller classifying many apps in a loop
 * (e.g. appDisplay.js building the whole grid) should call this once up
 * front and pass the same context into every getAppCategory() call, rather
 * than each of those calls independently re-reading and re-parsing
 * settings (custom-categories, app-category-overrides) for what is, within
 * a single pass, always the same result.
 */
export function getCategoryContext(settings) {
    return {
        categories: getCategories(settings),
        overrides: _loadOverrides(settings)
    };
}

/**
 * Determine the app's category, respecting overrides and enabled/merged
 * category validation. Pass a context from getCategoryContext() when
 * classifying many apps in one pass to avoid redundant settings reads.
 */
export function getAppCategory(appInfo, context) {
    try {
        const currentCategories = context.categories;

        const resolve = candidate =>
            _isValidTargetCategory(currentCategories, candidate) ? candidate : 'Other';

        // Check user overrides first (e.g. drag-and-drop into a
        // category), but validate them against current enabled/merged category config.
        try {
            const id = appInfo.get_id();
            const overrides = context.overrides;
            if (overrides.has(id)) {
                const overrideCategory = overrides.get(id).category;
                const catConfig = currentCategories.find(c => _categoryNamesEqual(c.name, overrideCategory));
                if (catConfig) {
                    if (!catConfig.enabled) {
                        return 'Other';
                    }
                    if (catConfig.merge) {
                        return resolve(catConfig.merge);
                    }
                    return resolve(catConfig.name);
                }

                if (_categoryNamesEqual(overrideCategory, 'Other')) {
                    // An explicit, intentional placement into Other (e.g.
                    // dragging an app there, or reordering within it) -
                    // honor it as-is rather than falling through below.
                    return 'Other';
                }

                // No config found and it isn't 'Other' either, meaning the
                // custom category itself was deleted entirely (not just
                // disabled - that case is handled above and still resolves
                // to 'Other'). The override is now stale, so fall through
                // to natural detection via the app's own .desktop
                // Categories= below instead of stranding it in Other.
            }
        } catch (e) {
            // ignore if appInfo doesn't have get_id
        }
        const categories = appInfo.get_categories();
        if (!categories)
            return 'Other';

        const categoryList = Array.isArray(categories) ?
            categories.map(c => String(c).trim()).filter(Boolean) :
            categories.split(';').map(c => String(c).trim()).filter(Boolean);

        // Use the app's own category list order so a specific enabled/merged
        // category can match before a broader disabled one.
        for (const trimmed of categoryList) {
            if (!trimmed) {
                continue;
            }
            const catConfig = currentCategories.find(c => _categoryNamesEqual(c.name, trimmed));
            if (!catConfig) {
                // Unknown category name to us, keep checking the app's other listed categories.
                continue;
            }
            if (!catConfig.enabled) {
                // This particular category is disabled; the app might
                // still match a different, enabled category it also lists.
                continue;
            }
            if (catConfig.merge) {
                return resolve(catConfig.merge);
            }
            return resolve(catConfig.name);
        }
    } catch (e) {
        console.error('Error getting app category:', e);
    }
    return 'Other';
}
