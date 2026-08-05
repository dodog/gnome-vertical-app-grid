import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

function easeOutCubic(t) {
    return (--t) * t * t + 1;
}

/*
Custom scroll view with animated scrolling and precise child targeting.
Used as the single scrolling container for the whole vertical app grid.
*/
export const VerticalScrollView = GObject.registerClass({
    GTypeName: 'Vertigrid_VerticalScrollView'
}, class VerticalScrollView extends St.ScrollView {
        constructor(settings) {
            super({
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
