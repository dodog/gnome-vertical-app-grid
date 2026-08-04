import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

/*
Simple, fixed-column grid layout manager. Every viewport in the vertical
app grid (favorites, "All Apps", and each category section) gets its own
instance of this.
*/
export const VerticalLayout = GObject.registerClass({
    GTypeName: 'Vertigrid_VerticalLayout'
}, class VerticalLayout extends Clutter.LayoutManager {
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
