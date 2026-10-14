/* Always On Top: Ctrl+Super+T pins the focused window above all others,
 * and every pinned window is outlined with a blue border. */

const { Gdk, GLib, GObject, Meta, Shell, St } = imports.gi;
const Cairo = imports.gi.cairo;

const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;

const KEYBINDING = 'toggle-always-on-top';
const BORDER_WIDTH = 3;
const BORDER_COLOR = '#3584e4';
/* Matches the rounded corners of libadwaita windows; smaller GTK3 and
 * window-frame corners sit inside its curve too. */
const WINDOW_CORNER_RADIUS = 12;
/* How far along an edge the reference pixel for corner detection lies,
 * comfortably past any window's corner rounding. */
const CORNER_PROBE_LENGTH = 16;
/* Lets a window redraw at its new size before its corners are inspected. */
const CORNER_DETECTION_DELAY_MS = 250;

const PINNABLE_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
];

/* Blue outline drawn just outside one pinned window's frame. Where the frame
 * touches the edge of the usable screen area, the border moves inside the
 * frame so the top bar, the dock or a neighbouring monitor cannot hide it.
 * Each border corner is rounded only where the window's own corner is, so a
 * square corner never pokes out through the curve. */
class Border {
    constructor(window) {
        this._window = window;
        this._actor = window.get_compositor_private();
        /* Top-left, top-right, bottom-right, bottom-left. */
        this._roundCorners = [true, true, true, true];
        this._cornerDetectionId = 0;

        this._widget = new St.Widget({ reactive: false });
        global.window_group.add_child(this._widget);

        this._visibleBinding = this._actor.bind_property(
            'visible',
            this._widget,
            'visible',
            GObject.BindingFlags.SYNC_CREATE
        );

        this._windowSignals = [
            window.connect('position-changed', () => this._syncGeometry()),
            window.connect('size-changed', () => {
                this._syncGeometry();
                this._scheduleCornerDetection();
            }),
        ];
        /* A window pinned before its first frame has no pixels to inspect
         * yet, so its corners are detected again once that frame is drawn.
         * The actor can already be destroyed when the window is unmanaged;
         * connectObject() drops these handlers along with it. */
        this._actor.connectObject(
            'notify::visible', () => this._scheduleCornerDetection(),
            'first-frame', () => this._scheduleCornerDetection(),
            this
        );
        this._displaySignals = [
            global.display.connect('restacked', () => this._syncStacking()),
            global.display.connect('workareas-changed', () => this._syncGeometry()),
        ];

        this._detectCorners();
        this._syncGeometry();
        this._syncStacking();
    }

    destroy() {
        if (this._cornerDetectionId)
            GLib.source_remove(this._cornerDetectionId);

        this._windowSignals.forEach(id => this._window.disconnect(id));
        this._actor.disconnectObject(this);
        this._displaySignals.forEach(id => global.display.disconnect(id));
        this._visibleBinding.unbind();
        this._widget.destroy();
    }

    _syncGeometry() {
        const frame = this._window.get_frame_rect();
        const bounds = this._window.is_fullscreen()
            ? global.display.get_monitor_geometry(this._window.get_monitor())
            : this._window.get_work_area_current_monitor();

        const left = outerEdge(frame.x, bounds.x, -BORDER_WIDTH);
        const top = outerEdge(frame.y, bounds.y, -BORDER_WIDTH);
        const right = outerEdge(frame.x + frame.width, bounds.x + bounds.width, BORDER_WIDTH);
        const bottom = outerEdge(frame.y + frame.height, bounds.y + bounds.height, BORDER_WIDTH);

        this._widget.set_position(left, top);
        this._widget.set_size(right - left, bottom - top);

        const radii = this._roundCorners.map(round => {
            return round && this._isFloating() ? `${WINDOW_CORNER_RADIUS + BORDER_WIDTH}px` : '0';
        });
        this._widget.set_style(
            `border: ${BORDER_WIDTH}px solid ${BORDER_COLOR}; border-radius: ${radii.join(' ')};`
        );
    }

    /* Maximized, tiled and fullscreen windows draw square corners anyway. */
    _isFloating() {
        return !this._window.is_fullscreen() && this._window.get_maximized() === 0;
    }

    _scheduleCornerDetection() {
        if (this._cornerDetectionId)
            GLib.source_remove(this._cornerDetectionId);

        this._cornerDetectionId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            CORNER_DETECTION_DELAY_MS,
            () => {
                this._cornerDetectionId = 0;
                this._detectCorners();
                this._syncGeometry();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /* Only a floating, visible window shows its real corner shape. */
    _detectCorners() {
        if (!this._isFloating() || !this._actor.visible)
            return;

        /* Mutter 42's get_image() dereferences the window texture without a
         * NULL check and crashes the shell. The texture is missing until the
         * window's first frame, and briefly while its pixmap is rebound after
         * a resize or a decoration change. */
        const texture = this._actor.get_texture();
        if (!texture || !texture.get_texture())
            return;

        const frame = this._window.get_frame_rect();
        const buffer = this._window.get_buffer_rect();
        const left = frame.x - buffer.x;
        const top = frame.y - buffer.y;
        const right = left + frame.width - 1;
        const bottom = top + frame.height - 1;

        const corners = [
            isRoundCorner(this._actor, left, top, 1),
            isRoundCorner(this._actor, right, top, -1),
            isRoundCorner(this._actor, right, bottom, -1),
            isRoundCorner(this._actor, left, bottom, 1),
        ];
        if (corners.includes(null))
            return;

        this._roundCorners = corners;
    }

    /* Mutter's stack sync only orders window actors, so a foreign child of
     * window_group drifts; put the border back right above its window. */
    _syncStacking() {
        global.window_group.set_child_above_sibling(this._widget, this._actor);
    }
}

/* A rounded corner leaves the frame's corner pixel clearly more transparent
 * than the same edge a little further in. Comparing the two instead of
 * testing for full opacity keeps translucent windows working. `inward` is 1
 * when the edge continues to the right of (x, y) and -1 when to the left.
 * Returns null when the window's pixels cannot be read. */
function isRoundCorner(actor, x, y, inward) {
    const clip = new Cairo.RectangleInt({
        x: inward > 0 ? x : x - CORNER_PROBE_LENGTH,
        y,
        width: CORNER_PROBE_LENGTH + 1,
        height: 1,
    });
    const image = actor.get_image(clip);
    if (!image)
        return null;

    const pixbuf = Gdk.pixbuf_get_from_surface(image, 0, 0, clip.width, 1);
    if (!pixbuf)
        return null;

    const pixels = pixbuf.read_pixel_bytes().toArray();
    const cornerIndex = inward > 0 ? 0 : CORNER_PROBE_LENGTH;
    const edgeIndex = CORNER_PROBE_LENGTH - cornerIndex;
    const cornerAlpha = pixels[cornerIndex * 4 + 3];
    const edgeAlpha = pixels[edgeIndex * 4 + 3];

    return cornerAlpha < edgeAlpha / 2;
}

/* Pushes a frame edge outward by `offset`, but not past `bound` when the frame
 * itself is still within it. */
function outerEdge(edge, bound, offset) {
    const pushed = edge + offset;

    if (offset < 0)
        return edge >= bound ? Math.max(pushed, bound) : pushed;
    return edge <= bound ? Math.min(pushed, bound) : pushed;
}

class Extension {
    enable() {
        this._borders = new Map();
        this._windowSignals = new Map();

        Main.wm.addKeybinding(
            KEYBINDING,
            ExtensionUtils.getSettings(),
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => this._toggleFocusedWindow()
        );

        this._windowCreatedId = global.display.connect(
            'window-created',
            (_display, window) => this._trackWindow(window)
        );
        global.get_window_actors().forEach(actor => this._trackWindow(actor.meta_window));
    }

    disable() {
        Main.wm.removeKeybinding(KEYBINDING);
        global.display.disconnect(this._windowCreatedId);

        this._windowSignals.forEach((ids, window) => ids.forEach(id => window.disconnect(id)));
        this._windowSignals.clear();

        this._borders.forEach(border => border.destroy());
        this._borders.clear();
    }

    _toggleFocusedWindow() {
        const window = global.display.get_focus_window();
        if (!window || !PINNABLE_TYPES.includes(window.get_window_type()))
            return;

        if (window.is_above())
            window.unmake_above();
        else
            window.make_above();
    }

    /* The border follows the window's above state rather than the keypress,
     * so pinning from the window menu (Alt+Space) is outlined too. */
    _trackWindow(window) {
        if (this._windowSignals.has(window))
            return;

        this._windowSignals.set(window, [
            window.connect('notify::above', () => this._syncBorder(window)),
            window.connect('shown', () => this._syncBorder(window)),
            window.connect('unmanaged', () => this._untrackWindow(window)),
        ]);

        this._syncBorder(window);
    }

    _untrackWindow(window) {
        this._windowSignals.get(window).forEach(id => window.disconnect(id));
        this._windowSignals.delete(window);

        this._removeBorder(window);
    }

    _syncBorder(window) {
        const wantsBorder = window.is_above() && PINNABLE_TYPES.includes(window.get_window_type());

        if (!wantsBorder) {
            this._removeBorder(window);
            return;
        }

        /* A brand-new window has no actor until it is shown; 'shown' retries. */
        if (this._borders.has(window) || !window.get_compositor_private())
            return;

        this._borders.set(window, new Border(window));
    }

    _removeBorder(window) {
        const border = this._borders.get(window);
        if (!border)
            return;

        border.destroy();
        this._borders.delete(window);
    }
}

function init() {
    return new Extension();
}
