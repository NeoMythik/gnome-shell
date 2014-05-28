// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const GnomeDesktop = imports.gi.GnomeDesktop;
const Atk = imports.gi.Atk;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;
const Tp = imports.gi.TelepathyGLib;

const BoxPointer = imports.ui.boxpointer;
const CtrlAltTab = imports.ui.ctrlAltTab;
const GnomeSession = imports.misc.gnomeSession;
const GrabHelper = imports.ui.grabHelper;
const Layout = imports.ui.layout;
const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;
const PointerWatcher = imports.ui.pointerWatcher;
const PopupMenu = imports.ui.popupMenu;
const Params = imports.misc.params;
const Tweener = imports.ui.tweener;
const Util = imports.misc.util;

const SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';

const ANIMATION_TIME = 0.2;
const NOTIFICATION_TIMEOUT = 4;

const HIDE_TIMEOUT = 0.2;
const LONGER_HIDE_TIMEOUT = 0.6;

// We delay hiding of the tray if the mouse is within MOUSE_LEFT_ACTOR_THRESHOLD
// range from the point where it left the tray.
const MOUSE_LEFT_ACTOR_THRESHOLD = 20;

// Time the user needs to leave the mouse on the bottom pixel row to open the tray
const TRAY_DWELL_TIME = 1000; // ms
// Time resolution when tracking the mouse to catch the open tray dwell
const TRAY_DWELL_CHECK_INTERVAL = 100; // ms

const IDLE_TIME = 1000;

const MESSAGE_TRAY_PRESSURE_THRESHOLD = 250; // pixels
const MESSAGE_TRAY_PRESSURE_TIMEOUT = 1000; // ms

const State = {
    HIDDEN:  0,
    SHOWING: 1,
    SHOWN:   2,
    HIDING:  3
};

// These reasons are useful when we destroy the notifications received through
// the notification daemon. We use EXPIRED for transient notifications that the
// user did not interact with, DISMISSED for all other notifications that were
// destroyed as a result of a user action, and SOURCE_CLOSED for the notifications
// that were requested to be destroyed by the associated source.
const NotificationDestroyedReason = {
    EXPIRED: 1,
    DISMISSED: 2,
    SOURCE_CLOSED: 3
};

// Message tray has its custom Urgency enumeration. LOW, NORMAL and CRITICAL
// urgency values map to the corresponding values for the notifications received
// through the notification daemon. HIGH urgency value is used for chats received
// through the Telepathy client.
const Urgency = {
    LOW: 0,
    NORMAL: 1,
    HIGH: 2,
    CRITICAL: 3
};

function _fixMarkup(text, allowMarkup) {
    if (allowMarkup) {
        // Support &amp;, &quot;, &apos;, &lt; and &gt;, escape all other
        // occurrences of '&'.
        let _text = text.replace(/&(?!amp;|quot;|apos;|lt;|gt;)/g, '&amp;');

        // Support <b>, <i>, and <u>, escape anything else
        // so it displays as raw markup.
        _text = _text.replace(/<(?!\/?[biu]>)/g, '&lt;');

        try {
            Pango.parse_markup(_text, -1, '');
            return _text;
        } catch (e) {}
    }

    // !allowMarkup, or invalid markup
    return GLib.markup_escape_text(text, -1);
}

const FocusGrabber = new Lang.Class({
    Name: 'FocusGrabber',

    _init: function(actor) {
        this._actor = actor;
        this._prevKeyFocusActor = null;
        this._focusActorChangedId = 0;
        this._focused = false;
    },

    grabFocus: function() {
        if (this._focused)
            return;

        this._prevFocusedWindow = global.display.focus_window;
        this._prevKeyFocusActor = global.stage.get_key_focus();

        this._focusActorChangedId = global.stage.connect('notify::key-focus', Lang.bind(this, this._focusActorChanged));

        if (!this._actor.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false))
            this._actor.grab_key_focus();

        this._focused = true;
    },

    _focusUngrabbed: function() {
        if (!this._focused)
            return false;

        if (this._focusActorChangedId > 0) {
            global.stage.disconnect(this._focusActorChangedId);
            this._focusActorChangedId = 0;
        }

        this._focused = false;
        return true;
    },

    _focusActorChanged: function() {
        let focusedActor = global.stage.get_key_focus();
        if (!focusedActor || !this._actor.contains(focusedActor))
            this._focusUngrabbed();
    },

    ungrabFocus: function() {
        if (!this._focusUngrabbed())
            return;

        if (this._prevKeyFocusActor) {
            global.stage.set_key_focus(this._prevKeyFocusActor);
            this._prevKeyFocusActor = null;
        } else {
            let focusedActor = global.stage.get_key_focus();
            if (focusedActor && this._actor.contains(focusedActor))
                global.stage.set_key_focus(null);
        }
    }
});

const URLHighlighter = new Lang.Class({
    Name: 'URLHighlighter',

    _init: function() {
        this.actor = new St.Label({ reactive: true, style_class: 'url-highlighter' });
        this._linkColor = '#ccccff';
        this.actor.connect('style-changed', Lang.bind(this, function() {
            let [hasColor, color] = this.actor.get_theme_node().lookup_color('link-color', false);
            if (hasColor) {
                let linkColor = color.to_string().substr(0, 7);
                if (linkColor != this._linkColor) {
                    this._linkColor = linkColor;
                    this._highlightUrls();
                }
            }
        }));

        this.actor.connect('button-press-event', Lang.bind(this, function(actor, event) {
            // Don't try to URL highlight when invisible.
            // The MessageTray doesn't actually hide us, so
            // we need to check for paint opacities as well.
            if (!actor.visible || actor.get_paint_opacity() == 0)
                return Clutter.EVENT_PROPAGATE;

            // Keep Notification.actor from seeing this and taking
            // a pointer grab, which would block our button-release-event
            // handler, if an URL is clicked
            return this._findUrlAtPos(event) != -1;
        }));
        this.actor.connect('button-release-event', Lang.bind(this, function (actor, event) {
            if (!actor.visible || actor.get_paint_opacity() == 0)
                return Clutter.EVENT_PROPAGATE;

            let urlId = this._findUrlAtPos(event);
            if (urlId != -1) {
                let url = this._urls[urlId].url;
                if (url.indexOf(':') == -1)
                    url = 'http://' + url;

                Gio.app_info_launch_default_for_uri(url, global.create_app_launch_context(0, -1));
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }));
        this.actor.connect('motion-event', Lang.bind(this, function(actor, event) {
            if (!actor.visible || actor.get_paint_opacity() == 0)
                return Clutter.EVENT_PROPAGATE;

            let urlId = this._findUrlAtPos(event);
            if (urlId != -1 && !this._cursorChanged) {
                global.screen.set_cursor(Meta.Cursor.POINTING_HAND);
                this._cursorChanged = true;
            } else if (urlId == -1) {
                global.screen.set_cursor(Meta.Cursor.DEFAULT);
                this._cursorChanged = false;
            }
            return Clutter.EVENT_PROPAGATE;
        }));
        this.actor.connect('leave-event', Lang.bind(this, function() {
            if (!this.actor.visible || this.actor.get_paint_opacity() == 0)
                return Clutter.EVENT_PROPAGATE;

            if (this._cursorChanged) {
                this._cursorChanged = false;
                global.screen.set_cursor(Meta.Cursor.DEFAULT);
            }
            return Clutter.EVENT_PROPAGATE;
        }));
    },

    hasText: function() {
        return !!this._text;
    },

    setMarkup: function(text, allowMarkup) {
        text = text ? _fixMarkup(text, allowMarkup) : '';
        this._text = text;

        this.actor.clutter_text.set_markup(text);
        /* clutter_text.text contain text without markup */
        this._urls = Util.findUrls(this.actor.clutter_text.text);
        this._highlightUrls();
    },

    _highlightUrls: function() {
        // text here contain markup
        let urls = Util.findUrls(this._text);
        let markup = '';
        let pos = 0;
        for (let i = 0; i < urls.length; i++) {
            let url = urls[i];
            let str = this._text.substr(pos, url.pos - pos);
            markup += str + '<span foreground="' + this._linkColor + '"><u>' + url.url + '</u></span>';
            pos = url.pos + url.url.length;
        }
        markup += this._text.substr(pos);
        this.actor.clutter_text.set_markup(markup);
    },

    _findUrlAtPos: function(event) {
        let success;
        let [x, y] = event.get_coords();
        [success, x, y] = this.actor.transform_stage_point(x, y);
        let find_pos = -1;
        for (let i = 0; i < this.actor.clutter_text.text.length; i++) {
            let [success, px, py, line_height] = this.actor.clutter_text.position_to_coords(i);
            if (py > y || py + line_height < y || x < px)
                continue;
            find_pos = i;
        }
        if (find_pos != -1) {
            for (let i = 0; i < this._urls.length; i++)
            if (find_pos >= this._urls[i].pos &&
                this._urls[i].pos + this._urls[i].url.length > find_pos)
                return i;
        }
        return -1;
    }
});

// NotificationPolicy:
// An object that holds all bits of configurable policy related to a notification
// source, such as whether to play sound or honour the critical bit.
//
// A notification without a policy object will inherit the default one.
const NotificationPolicy = new Lang.Class({
    Name: 'NotificationPolicy',

    _init: function(params) {
        params = Params.parse(params, { enable: true,
                                        enableSound: true,
                                        showBanners: true,
                                        forceExpanded: false,
                                        showInLockScreen: true,
                                        detailsInLockScreen: false
                                      });
        Lang.copyProperties(params, this);
    },

    // Do nothing for the default policy. These methods are only useful for the
    // GSettings policy.
    store: function() { },
    destroy: function() { }
});
Signals.addSignalMethods(NotificationPolicy.prototype);

const NotificationGenericPolicy = new Lang.Class({
    Name: 'NotificationGenericPolicy',
    Extends: NotificationPolicy,

    _init: function() {
        // Don't chain to parent, it would try setting
        // our properties to the defaults

        this.id = 'generic';

        this._masterSettings = new Gio.Settings({ schema: 'org.gnome.desktop.notifications' });
        this._masterSettings.connect('changed', Lang.bind(this, this._changed));
    },

    store: function() { },

    destroy: function() {
        this._masterSettings.run_dispose();
    },

    _changed: function(settings, key) {
        this.emit('policy-changed', key);
    },

    get enable() {
        return true;
    },

    get enableSound() {
        return true;
    },

    get showBanners() {
        return this._masterSettings.get_boolean('show-banners');
    },

    get forceExpanded() {
        return false;
    },

    get showInLockScreen() {
        return this._masterSettings.get_boolean('show-in-lock-screen');
    },

    get detailsInLockScreen() {
        return false;
    }
});

const NotificationApplicationPolicy = new Lang.Class({
    Name: 'NotificationApplicationPolicy',
    Extends: NotificationPolicy,

    _init: function(id) {
        // Don't chain to parent, it would try setting
        // our properties to the defaults

        this.id = id;
        this._canonicalId = this._canonicalizeId(id);

        this._masterSettings = new Gio.Settings({ schema: 'org.gnome.desktop.notifications' });
        this._settings = new Gio.Settings({ schema: 'org.gnome.desktop.notifications.application',
                                            path: '/org/gnome/desktop/notifications/application/' + this._canonicalId + '/' });

        this._masterSettings.connect('changed', Lang.bind(this, this._changed));
        this._settings.connect('changed', Lang.bind(this, this._changed));
    },

    store: function() {
        this._settings.set_string('application-id', this.id + '.desktop');

        let apps = this._masterSettings.get_strv('application-children');
        if (apps.indexOf(this._canonicalId) < 0) {
            apps.push(this._canonicalId);
            this._masterSettings.set_strv('application-children', apps);
        }
    },

    destroy: function() {
        this._masterSettings.run_dispose();
        this._settings.run_dispose();
    },

    _changed: function(settings, key) {
        this.emit('policy-changed', key);
    },

    _canonicalizeId: function(id) {
        // Keys are restricted to lowercase alphanumeric characters and dash,
        // and two dashes cannot be in succession
        return id.toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/--+/g, '-');
    },

    get enable() {
        return this._settings.get_boolean('enable');
    },

    get enableSound() {
        return this._settings.get_boolean('enable-sound-alerts');
    },

    get showBanners() {
        return this._masterSettings.get_boolean('show-banners') &&
            this._settings.get_boolean('show-banners');
    },

    get forceExpanded() {
        return this._settings.get_boolean('force-expanded');
    },

    get showInLockScreen() {
        return this._masterSettings.get_boolean('show-in-lock-screen') &&
            this._settings.get_boolean('show-in-lock-screen');
    },

    get detailsInLockScreen() {
        return this._settings.get_boolean('details-in-lock-screen');
    }
});

const RevealerLayout = new Lang.Class({
    Name: 'RevealerLayout',
    Extends: Clutter.BinLayout,

    _init: function() {
        this.parent();

        this._heightScale = 0;
    },

    vfunc_get_preferred_height: function(container, forWidth) {
        let [minHeight, natHeight] = this.parent(container, forWidth);
        minHeight *= this._heightScale;
        natHeight *= this._heightScale;
        return [minHeight, natHeight];
    },

    set heightScale(value) {
        if (this._heightScale == value)
            return;

        this._heightScale = value;
        this.layout_changed();
    },

    get heightScale() {
        return this._heightScale;
    },
});

const Revealer = new Lang.Class({
    Name: 'Revealer',

    _init: function(child) {
        this._layout = new RevealerLayout();
        this.actor = new St.Widget({ layout_manager: this._layout });
        this.actor.add_child(child);

        this._visible = false;
    },

    _setTo: function(heightScale, animate) {
        Tweener.removeTweens(this._layout);
        if (animate)
            Tweener.addTween(this._layout, { heightScale: heightScale,
                                             time: ANIMATION_TIME,
                                             transition: 'easeOutQuad' });
        else
            this._layout.heightScale = heightScale;
    },

    show: function(animate) {
        this._setTo(1, animate);
    },

    hide: function(animate) {
        this._setTo(0, animate);
    },
});

// Notification:
// @source: the notification's Source
// @title: the title
// @banner: the banner text
// @params: optional additional params
//
// Creates a notification. In the banner mode, the notification
// will show an icon, @title (in bold) and @banner, all on a single
// line (with @banner ellipsized if necessary).
//
// The notification will be expandable if either it has additional
// elements that were added to it or if the @banner text did not
// fit fully in the banner mode. When the notification is expanded,
// the @banner text from the top line is always removed. The complete
// @banner text is added to the notification by default. You can change
// what is displayed by setting the child of this._bodyBin.
//
// You can also add buttons to the notification with addButton(),
// and you can construct simple default buttons with addAction().
//
// By default, the icon shown is the same as the source's.
// However, if @params contains a 'gicon' parameter, the passed in gicon
// will be used.
//
// You can add a secondary icon to the banner with 'secondaryGIcon'. There
// is no fallback for this icon.
//
// If @params contains 'bannerMarkup', with the value %true, then
// the corresponding element is assumed to use pango markup. If the
// parameter is not present for an element, then anything that looks
// like markup in that element will appear literally in the output.
//
// If @params contains a 'clear' parameter with the value %true, then
// the content and the action area of the notification will be cleared.
//
// If @params contains 'soundName' or 'soundFile', the corresponding
// event sound is played when the notification is shown (if the policy for
// @source allows playing sounds).
const Notification = new Lang.Class({
    Name: 'Notification',

    ICON_SIZE: 32,

    _init: function(source, title, banner, params) {
        this.source = source;
        this.title = title;
        this.urgency = Urgency.NORMAL;
        // 'transient' is a reserved keyword in JS, so we have to use an alternate variable name
        this.isTransient = false;
        this.isMusic = false;
        this.forFeedback = false;
        this.expanded = false;
        this.focused = false;
        this.acknowledged = false;
        this._destroyed = false;
        this._titleDirection = Clutter.TextDirection.DEFAULT;
        this._soundName = null;
        this._soundFile = null;
        this._soundPlayed = false;

        // Let me draw you a picture:
        //
        //      ,. this._iconBin         ,. this._titleLabel
        //      |        ,. this._secondaryIconBin
        // .----|--------|---------------|------------.
        // | .-----. | .----.-----------------------. |
        // | |     | | |    |                       |--- this._titleBox
        // | '.....' | '....'.......................' |
        // |         |                                |- this._hbox
        // |         |        this._bodyBin           |
        // |         |                                | --- this._vbox
        // |_________|________________________________|
        // | this._actionArea                         |
        // |__________________________________________|
        // | this._buttonBox                          |
        // |__________________________________________|

        this.actor = new St.Button({ style_class: 'notification',
                                     accessible_role: Atk.Role.NOTIFICATION,
                                     x_fill: true, y_fill: true });
        this.actor._delegate = this;
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));
        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        // Separates the notification content, action area and button box
        this._vbox = new St.BoxLayout({ vertical: true });
        this.actor.child = this._vbox;

        // Separates the icon and title/body
        this._hbox = new St.BoxLayout({ style_class: 'notification-main-content' });
        this._vbox.add_child(this._hbox);

        this._iconBin = new St.Bin();
        this._hbox.add_child(this._iconBin);

        this._titleBodyBox = new St.BoxLayout({ style_class: 'notification-title-body-box',
                                                vertical: true });
        this._hbox.add_child(this._titleBodyBox);

        this._titleBox = new St.BoxLayout({ style_class: 'notification-title-box',
                                            x_expand: true, x_align: Clutter.ActorAlign.START });
        this._secondaryIconBin = new St.Bin();
        this._titleBox.add_child(this._secondaryIconBin);
        this._titleLabel = new St.Label({ x_expand: true });
        this._titleBox.add_child(this._titleLabel);
        this._titleBodyBox.add(this._titleBox);

        this._bodyScrollArea = new St.ScrollView({ style_class: 'notification-scrollview',
                                                   hscrollbar_policy: Gtk.PolicyType.NEVER });
        this._titleBodyBox.add(this._bodyScrollArea);
        this.enableScrolling(true);

        this._bodyScrollable = new St.BoxLayout();
        this._bodyScrollArea.add_actor(this._bodyScrollable);

        this._bodyBin = new St.Bin();
        this._bodyScrollable.add_actor(this._bodyBin);

        // By default, this._bodyBin contains a URL highlighter. Subclasses
        // can override this to provide custom content if they want to.
        this._bodyUrlHighlighter = new URLHighlighter();
        this._bodyBin.child = this._bodyUrlHighlighter.actor;

        this._actionAreaBin = new St.Bin({ style_class: 'notification-action-area',
                                           x_expand: true, y_expand: true });
        this._actionAreaRevealer = new Revealer(this._actionAreaBin);
        this._vbox.add_child(this._actionAreaRevealer.actor);

        this._buttonBox = new St.BoxLayout({ style_class: 'notification-button-box',
                                             x_expand: true, y_expand: true });
        global.focus_manager.add_group(this._buttonBox);
        this._buttonBoxRevealer = new Revealer(this._buttonBox);
        this._vbox.add_child(this._buttonBoxRevealer.actor);

        // If called with only one argument we assume the caller
        // will call .update() later on. This is the case of
        // NotificationDaemon, which wants to use the same code
        // for new and updated notifications
        if (arguments.length != 1)
            this.update(title, banner, params);

        this._sync();
    },

    _sync: function() {
        if (this.expanded) {
            if (this._actionArea != null)
                this._actionAreaRevealer.show(true);
            else
                this._actionAreaRevealer.hide(false);

            if (this._buttonBox.get_n_children() > 0)
                this._buttonBoxRevealer.show(true);
            else
                this._buttonBoxRevealer.hide(false);
        } else {
            this._actionAreaRevealer.hide(true);
            this._buttonBoxRevealer.hide(true);
        }

        this._iconBin.visible = (this._icon != null && this._icon.visible);
        this._secondaryIconBin.visible = (this._secondaryIcon != null);

        if (this.expanded) {
            this._titleLabel.clutter_text.line_wrap = true;
            this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._bodyUrlHighlighter.actor.clutter_text.line_wrap = true;
            this._bodyUrlHighlighter.actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        } else {
            this._titleLabel.clutter_text.line_wrap = false;
            this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._bodyUrlHighlighter.actor.clutter_text.line_wrap = false;
            this._bodyUrlHighlighter.actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        }
        this.enableScrolling(this.expanded);

        this._bodyUrlHighlighter.actor.visible = this._bodyUrlHighlighter.hasText();
    },

    // update:
    // @title: the new title
    // @banner: the new banner
    // @params: as in the Notification constructor
    //
    // Updates the notification by regenerating its icon and updating
    // the title/banner. If @params.clear is %true, it will also
    // remove any additional actors/action buttons previously added.
    update: function(title, banner, params) {
        params = Params.parse(params, { gicon: null,
                                        secondaryGIcon: null,
                                        bannerMarkup: false,
                                        clear: false,
                                        soundName: null,
                                        soundFile: null });

        let oldFocus = global.stage.key_focus;

        if (this._actionArea && params.clear) {
            if (oldFocus && this._actionArea.contains(oldFocus))
                this.actor.grab_key_focus();

            this._actionArea.destroy();
            this._actionArea = null;
        }

        if (params.clear) {
            this._buttonBox.destroy_all_children();
        }

        if (this._icon && (params.gicon || params.clear)) {
            this._icon.destroy();
            this._icon = null;
        }

        if (params.gicon) {
            this._icon = new St.Icon({ gicon: params.gicon,
                                       icon_size: this.ICON_SIZE });
        } else {
            this._icon = this.source.createIcon(this.ICON_SIZE);
        }

        if (this._icon)
            this._iconBin.child = this._icon;

        if (this._secondaryIcon && (params.secondaryGIcon || params.clear)) {
            this._secondaryIcon.destroy();
            this._secondaryIcon = null;
        }

        if (params.secondaryGIcon) {
            this._secondaryIcon = new St.Icon({ gicon: params.secondaryGIcon,
                                                style_class: 'secondary-icon' });
            this._secondaryIconBin.child = this._secondaryIcon;
        }

        this.title = title;
        title = title ? _fixMarkup(title.replace(/\n/g, ' '), false) : '';
        this._titleLabel.clutter_text.set_markup('<b>' + title + '</b>');

        if (Pango.find_base_dir(title, -1) == Pango.Direction.RTL)
            this._titleDirection = Clutter.TextDirection.RTL;
        else
            this._titleDirection = Clutter.TextDirection.LTR;

        // Let the title's text direction control the overall direction
        // of the notification - in case where different scripts are used
        // in the notification, this is the right thing for the icon, and
        // arguably for action buttons as well. Labels other than the title
        // will be allocated at the available width, so that their alignment
        // is done correctly automatically.
        this.actor.set_text_direction(this._titleDirection);

        this._bodyUrlHighlighter.setMarkup(banner, params.bannerMarkup);

        if (this._soundName != params.soundName ||
            this._soundFile != params.soundFile) {
            this._soundName = params.soundName;
            this._soundFile = params.soundFile;
            this._soundPlayed = false;
        }

        this._sync();
    },

    setIconVisible: function(visible) {
        this._icon.visible = visible;
        this._sync();
    },

    enableScrolling: function(enableScrolling) {
        let scrollPolicy = enableScrolling ? Gtk.PolicyType.AUTOMATIC : Gtk.PolicyType.NEVER;
        this._bodyScrollArea.vscrollbar_policy = scrollPolicy;
        this._bodyScrollArea.enable_mouse_scrolling = enableScrolling;
    },

    // scrollTo:
    // @side: St.Side.TOP or St.Side.BOTTOM
    //
    // Scrolls the content area (if scrollable) to the indicated edge
    scrollTo: function(side) {
        let adjustment = this._bodyScrollArea.vscroll.adjustment;
        if (side == St.Side.TOP)
            adjustment.value = adjustment.lower;
        else if (side == St.Side.BOTTOM)
            adjustment.value = adjustment.upper;
    },

    setActionArea: function(actor) {
        if (this._actionArea)
            this._actionArea.destroy();

        this._actionArea = actor;
        this._actionAreaBin.child = actor;
        this._sync();
    },

    addButton: function(button, callback) {
        this._buttonBox.add(button);
        button.connect('clicked', Lang.bind(this, function() {
            callback();

            this.emit('done-displaying');
            this.destroy();
        }));

        this._sync();
        return button;
    },

    // addAction:
    // @label: the label for the action's button
    // @callback: the callback for the action
    //
    // Adds a button with the given @label to the notification. All
    // action buttons will appear in a single row at the bottom of
    // the notification.
    addAction: function(label, callback) {
        let button = new St.Button({ style_class: 'notification-button',
                                     x_expand: true, label: label, can_focus: true });

        return this.addButton(button, callback);
    },

    setUrgency: function(urgency) {
        this.urgency = urgency;
    },

    setTransient: function(isTransient) {
        this.isTransient = isTransient;
    },

    setForFeedback: function(forFeedback) {
        this.forFeedback = forFeedback;
    },

    _styleChanged: function() {
        this._spacing = this._table.get_theme_node().get_length('spacing-columns');
    },

    _bannerBoxGetPreferredWidth: function(actor, forHeight, alloc) {
        let [titleMin, titleNat] = this._titleLabel.get_preferred_width(forHeight);
        let [bannerMin, bannerNat] = this._bannerLabel.get_preferred_width(forHeight);

        if (this._secondaryIcon) {
            let [secondaryIconMin, secondaryIconNat] = this._secondaryIcon.get_preferred_width(forHeight);

            alloc.min_size = secondaryIconMin + this._spacing + titleMin;
            alloc.natural_size = secondaryIconNat + this._spacing + titleNat + this._spacing + bannerNat;
        } else {
            alloc.min_size = titleMin;
            alloc.natural_size = titleNat + this._spacing + bannerNat;
        }
    },

    playSound: function() {
        if (this._soundPlayed)
            return;

        if (!this.source.policy.enableSound) {
            this._soundPlayed = true;
            return;
        }

        if (this._soundName) {
            if (this.source.app) {
                let app = this.source.app;

                global.play_theme_sound_full(0, this._soundName,
                                             this.title, null,
                                             app.get_id(), app.get_name());
            } else {
                global.play_theme_sound(0, this._soundName, this.title, null);
            }
        } else if (this._soundFile) {
            if (this.source.app) {
                let app = this.source.app;

                global.play_sound_file_full(0, this._soundFile,
                                            this.title, null,
                                            app.get_id(), app.get_name());
            } else {
                global.play_sound_file(0, this._soundFile, this.title, null);
            }
        }
    },

    expand: function(animate) {
        this.expanded = true;
        this._sync();
        this.emit('expanded');
    },

    collapseCompleted: function() {
        if (this._destroyed)
            return;

        this.expanded = false;
        this._sync();
    },

    _onClicked: function() {
        this.emit('clicked');
        this.emit('done-displaying');
        this.destroy();
    },

    _onDestroy: function() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (!this._destroyedReason)
            this._destroyedReason = NotificationDestroyedReason.DISMISSED;
        this.emit('destroy', this._destroyedReason);
    },

    destroy: function(reason) {
        this._destroyedReason = reason;
        this.actor.destroy();
        this.actor._delegate = null;
    }
});
Signals.addSignalMethods(Notification.prototype);

const Source = new Lang.Class({
    Name: 'MessageTraySource',

    SOURCE_ICON_SIZE: 48,

    _init: function(title, iconName) {
        this.title = title;
        this.iconName = iconName;

        this.isChat = false;
        this.isMuted = false;
        this.keepTrayOnSummaryClick = false;

        this.notifications = [];

        this.policy = this._createPolicy();
    },

    get count() {
        return this.notifications.length;
    },

    get indicatorCount() {
        let notifications = this.notifications.filter(function(n) { return !n.isTransient; });
        return notifications.length;
    },

    get unseenCount() {
        return this.notifications.filter(function(n) { return !n.acknowledged; }).length;
    },

    get countVisible() {
        return this.count > 1;
    },

    get isClearable() {
        return !this.isChat;
    },

    countUpdated: function() {
        this.emit('count-updated');
    },

    _createPolicy: function() {
        return new NotificationPolicy();
    },

    setTitle: function(newTitle) {
        this.title = newTitle;
        this.emit('title-changed');
    },

    setMuted: function(muted) {
        if (!this.isChat || this.isMuted == muted)
            return;
        this.isMuted = muted;
        this.emit('muted-changed');
    },

    // Called to create a new icon actor.
    // Provides a sane default implementation, override if you need
    // something more fancy.
    createIcon: function(size) {
        return new St.Icon({ gicon: this.getIcon(),
                             icon_size: size });
    },

    getIcon: function() {
        return new Gio.ThemedIcon({ name: this.iconName });
    },

    _onNotificationDestroy: function(notification) {
        let index = this.notifications.indexOf(notification);
        if (index < 0)
            return;

        this.notifications.splice(index, 1);
        if (this.notifications.length == 0)
            this._lastNotificationRemoved();

        this.countUpdated();
    },

    pushNotification: function(notification) {
        if (this.notifications.indexOf(notification) >= 0)
            return;

        notification.connect('destroy', Lang.bind(this, this._onNotificationDestroy));
        this.notifications.push(notification);
        this.emit('notification-added', notification);

        this.countUpdated();
    },

    notify: function(notification) {
        notification.acknowledged = false;
        this.pushNotification(notification);

        if (!this.isMuted) {
            // Play the sound now, if banners are disabled.
            // Otherwise, it will be played when the notification
            // is next shown.
            if (this.policy.showBanners) {
                this.emit('notify', notification);
            } else {
                notification.playSound();
            }
        }
    },

    destroy: function(reason) {
        this.policy.destroy();

        let notifications = this.notifications;
        this.notifications = [];

        for (let i = 0; i < notifications.length; i++)
            notifications[i].destroy(reason);

        this.emit('destroy', reason);
    },

    iconUpdated: function() {
        this.emit('icon-updated');
    },

    //// Protected methods ////
    _setSummaryIcon: function(icon) {
        this._mainIcon.setIcon(icon);
        this.iconUpdated();
    },

    // To be overridden by subclasses
    open: function() {
    },

    destroyNotifications: function() {
        for (let i = this.notifications.length - 1; i >= 0; i--)
            this.notifications[i].destroy();

        this.countUpdated();
    },

    // Default implementation is to destroy this source, but subclasses can override
    _lastNotificationRemoved: function() {
        this.destroy();
    },

    getMusicNotification: function() {
        for (let i = 0; i < this.notifications.length; i++) {
            if (this.notifications[i].isMusic)
                return this.notifications[i];
        }

        return null;
    },
});
Signals.addSignalMethods(Source.prototype);

const MessageTrayIndicator = new Lang.Class({
    Name: 'MessageTrayIndicator',

    _init: function(tray) {
        this._tray = tray;

        this.actor = new St.BoxLayout({ style_class: 'message-tray-indicator',
                                        reactive: true,
                                        track_hover: true,
                                        vertical: true,
                                        x_expand: true,
                                        y_expand: true,
                                        y_align: Clutter.ActorAlign.START });
        this.actor.connect('notify::height', Lang.bind(this, function() {
            this.actor.translation_y = -this.actor.height;
        }));
        this.actor.connect('button-press-event', Lang.bind(this, function() {
            this._tray.openTray();
            this._pressureBarrier.reset();
        }));

        this._count = new St.Label({ style_class: 'message-tray-indicator-count',
                                     x_expand: true,
                                     x_align: Clutter.ActorAlign.CENTER });
        this.actor.add_child(this._count);

        this._tray.connect('indicator-count-updated', Lang.bind(this, this._syncCount));
        this._syncCount();

        this._glow = new St.Widget({ style_class: 'message-tray-indicator-glow',
                                     x_expand: true });
        this.actor.add_child(this._glow);

        this._pressureBarrier = new Layout.PressureBarrier(MESSAGE_TRAY_PRESSURE_THRESHOLD,
                                                           MESSAGE_TRAY_PRESSURE_TIMEOUT,
                                                           Shell.KeyBindingMode.NORMAL |
                                                           Shell.KeyBindingMode.OVERVIEW);
        this._pressureBarrier.setEventFilter(this._barrierEventFilter);
        Main.layoutManager.connect('monitors-changed', Lang.bind(this, this._updateBarrier));
        this._updateBarrier();

        this._pressureBarrier.connect('pressure-changed', Lang.bind(this, this._updatePressure));
        this._pressureValue = 0;
        this._syncGlow();
    },

    _updateBarrier: function() {
        let monitor = Main.layoutManager.bottomMonitor;

        if (this._barrier) {
            this._pressureBarrier.removeBarrier(this._trayBarrier);
            this._barrier.destroy();
            this._barrier = null;
        }

        this._barrier = new Meta.Barrier({ display: global.display,
                                           x1: monitor.x, x2: monitor.x + monitor.width,
                                           y1: monitor.y + monitor.height, y2: monitor.y + monitor.height,
                                           directions: Meta.BarrierDirection.NEGATIVE_Y });
        this._pressureBarrier.addBarrier(this._barrier);
    },

    _trayBarrierEventFilter: function(event) {
        // Throw out all events where the pointer was grabbed by another
        // client, as the client that grabbed the pointer expects to have
        // complete control over it
        if (event.grabbed && Main.modalCount == 0)
            return true;

        if (this._tray.hasVisibleNotification())
            return true;

        return false;
    },

    _syncCount: function() {
        let count = this._tray.indicatorCount;
        this._count.visible = (count > 0);
        this._count.text = '' + count;
    },

    _syncGlow: function() {
        let value = this._pressureValue;
        let percent = value / this._pressureBarrier.threshold;
        this.actor.opacity = Math.min(percent * 255, 255);
        this.actor.visible = (value > 0);
    },

    get pressureValue() {
        return this._pressureValue;
    },

    set pressureValue(value) {
        this._pressureValue = value;
        this._syncGlow();
   },

    _updatePressure: function() {
        let value = this._pressureBarrier.currentPressure;
        this.pressureValue = value;
        if (value > 0) {
            Tweener.removeTweens(this);
            Tweener.addTween(this, { time: 1,
                                     delay: this._pressureBarrier.timeout / 1000,
                                     pressureValue: 0 });
        }
    },

    destroy: function() {
        this.actor.destroy();
    },
});

const SystemTrayIconButton = new Lang.Class({
    Name: 'SystemTrayIconButton',

    _init: function(trayIcon) {
        this._trayIcon = trayIcon;

        this.actor = new St.Button({ style_class: 'system-tray-icon-button',
                                     track_hover: true,
                                     can_focus: true,
                                     reactive: true });
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));
        this.actor.set_child(this._trayIcon);

        this._trayIcon.connect('destroy', Lang.bind(this, function() {
            this.actor.set_child(null);
            this.actor.destroy();
        }));
    },

    _onClicked: function() {
        let event = Clutter.get_current_event();

        let id = global.stage.connect('deactivate', Lang.bind(this, function() {
            global.stage.disconnect(id);
            this._trayIcon.click(event);
        }));

        this.emit('clicked');

        Main.overview.hide();
        return true;
    },
});
Signals.addSignalMethods(SystemTrayIconButton.prototype);

const SystemTraySection = new Lang.Class({
    Name: 'SystemTraySection',

    _init: function(tray) {
        this._tray = tray;

        this.actor = new St.BoxLayout({ style_class: 'system-tray-icons',
                                        y_align: Clutter.ActorAlign.CENTER,
                                        y_expand: true });

        this._trayManager = new Shell.TrayManager();
        this._trayManager.connect('tray-icon-added', Lang.bind(this, this._onTrayIconAdded));
        this._trayManager.connect('tray-icon-removed', Lang.bind(this, this._onTrayIconRemoved));

        this._trayManager.manage_screen(global.screen, this.actor);
    },

    _onTrayIconAdded: function(manager, trayIcon) {
        let button = new SystemTrayIconButton(trayIcon);
        button.connect('clicked', Lang.bind(this, function() {
            this._tray.close();
        }));
        this.actor.add_child(button.actor);
    },

    _onTrayIconRemoved: function(manager, trayIcon) {
        trayIcon.destroy();
    },
});

const NotificationDrawer = new Lang.Class({
    Name: 'NotificationDrawer',

    _init: function(tray) {
        this._tray = tray;

        this.actor = new St.BoxLayout({ style_class: 'notification-drawer',
                                        vertical: true });

        this._footer = new St.BoxLayout({ style_class: 'notification-drawer-footer' });
        this.actor.add_child(this._footer);

        this._footerActions = new St.BoxLayout({ style_class: 'notification-drawer-footer-actions' });

        this._clearButton = new St.Button({ reactive: true,
                                            can_focus: true,
                                            track_hover: true,
                                            accessible_name: _("Clear all notifications"),
                                            style_class: 'notification-drawer-button' });
        this._clearButton.child = new St.Icon({ icon_name: 'edit-clear-all-symbolic' });
        this._clearButton.connect('clicked', Lang.bind(this, this._clearAllNotifications));
        this._footerActions.add_child(this._clearButton);

        this._settingsButton = new St.Button({ reactive: true,
                                               can_focus: true,
                                               track_hover: true,
                                               button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
                                               accessible_name: _("Settings"),
                                               accessible_role: Atk.Role.MENU,
                                               style_class: 'notification-drawer-button' });
        this._settingsButton.child = new St.Icon({ icon_name: 'emblem-system-symbolic' });
        this._settingsButton.connect('clicked', Lang.bind(this, this._launchSettings));
        this._footerActions.add_child(this._settingsButton);

        this._footer.add_child(this._footerActions);

        this._systemTray = new SystemTraySection(this._tray);
        this._footer.add_child(this._systemTray.actor);
    },

    _clearAllNotifications: function() {
        let toDestroy = this._tray.getSources().filter(function(source) {
            return source.isClearable;
        });

        toDestroy.forEach(function(source) {
            source.destroy();
        });
    },

    _launchSettings: function() {
        let app = Shell.AppSystem.get_default().lookup_app('gnome-notifications-panel.desktop');
        app.activate();

        Main.overview.hide();
        this._tray.close();
    },
});

const MessageTray = new Lang.Class({
    Name: 'MessageTray',

    _init: function() {
        this._presence = new GnomeSession.Presence(Lang.bind(this, function(proxy, error) {
            this._onStatusChanged(proxy.status);
        }));
        this._busy = false;
        this._presence.connectSignal('StatusChanged', Lang.bind(this, function(proxy, senderName, [status]) {
            this._onStatusChanged(status);
        }));

        this._notificationWidget = new St.Widget({ name: 'notification-container',
                                                   reactive: true,
                                                   track_hover: true,
                                                   y_align: Clutter.ActorAlign.START,
                                                   x_align: Clutter.ActorAlign.CENTER,
                                                   y_expand: true,
                                                   x_expand: true,
                                                   layout_manager: new Clutter.BinLayout() });
        this._notificationRevealer = new Revealer(this._notificationWidget);

        this._notificationWidget.connect('key-release-event', Lang.bind(this, this._onNotificationKeyRelease));
        this._notificationWidget.connect('notify::hover', Lang.bind(this, this._onNotificationHoverChanged));
        this._notificationWidget.connect('notify::height', Lang.bind(this, function() {
            this._notificationWidget.translation_y = -this._notificationWidget.height;
        }));

        this._notificationBin = new St.Bin({ y_expand: true });
        this._notificationBin.set_y_align(Clutter.ActorAlign.START);
        this._notificationWidget.add_actor(this._notificationBin);
        this._notificationWidget.hide();
        this._notificationFocusGrabber = new FocusGrabber(this._notificationWidget);
        this._notificationQueue = [];
        this._notification = null;
        this._notificationClickedId = 0;

        this._closeButton = Util.makeCloseButton();
        this._closeButton.hide();
        this._closeButton.connect('clicked', Lang.bind(this, this._closeNotification));
        this._notificationWidget.add_actor(this._closeButton);

        this._userActiveWhileNotificationShown = false;

        this.idleMonitor = Meta.IdleMonitor.get_core();

        /*
        Main.layoutManager.connect('keyboard-visible-changed', Lang.bind(this, this._onKeyboardVisibleChanged));
        */

        // pointerInNotification is sort of a misnomer -- it tracks whether
        // a message tray notification should expand. The value is
        // partially driven by the hover state of the notification, but has
        // a lot of complex state related to timeouts and the current
        // state of the pointer when a notification pops up.
        this._pointerInNotification = false;

        // This tracks this._notificationWidget.hover and is used to fizzle
        // out non-changing hover notifications in onNotificationHoverChanged.
        this._notificationHovered = false;

        this._keyboardVisible = false;
        this._notificationState = State.HIDDEN;
        this._notificationTimeoutId = 0;
        this._notificationExpandedId = 0;
        this._notificationRemoved = false;
        this._reNotifyAfterHideNotification = null;
        this._inCtrlAltTab = false;

        this.clearableCount = 0;

        Main.layoutManager.trayBox.add_actor(this._notificationRevealer.actor);
        Main.layoutManager.trackChrome(this._notificationWidget);
        Main.layoutManager.trackChrome(this._closeButton);

        this._notificationDrawer = new NotificationDrawer(this);
        this._notificationDrawer.actor.x_align = Clutter.ActorAlign.CENTER;
        this._notificationDrawer.actor.x_expand = true;
        Main.layoutManager.trayBox.add_actor(this._notificationDrawer.actor);
        Main.layoutManager.trackChrome(this._notificationDrawer.actor);

        global.screen.connect('in-fullscreen-changed', Lang.bind(this, this._updateState));
        Main.layoutManager.connect('hot-corners-changed', Lang.bind(this, this._hotCornersChanged));

        Main.sessionMode.connect('updated', Lang.bind(this, this._sessionUpdated));

        Main.wm.addKeybinding('toggle-message-tray',
                              new Gio.Settings({ schema: SHELL_KEYBINDINGS_SCHEMA }),
                              Meta.KeyBindingFlags.NONE,
                              Shell.KeyBindingMode.NORMAL |
                              Shell.KeyBindingMode.MESSAGE_TRAY |
                              Shell.KeyBindingMode.OVERVIEW,
                              Lang.bind(this, this.toggleAndNavigate));
        Main.wm.addKeybinding('focus-active-notification',
                              new Gio.Settings({ schema: SHELL_KEYBINDINGS_SCHEMA }),
                              Meta.KeyBindingFlags.NONE,
                              Shell.KeyBindingMode.NORMAL |
                              Shell.KeyBindingMode.MESSAGE_TRAY |
                              Shell.KeyBindingMode.OVERVIEW,
                              Lang.bind(this, this._expandActiveNotification));

        this._sources = new Map();

        this._trayDwellTimeoutId = 0;
        // this._setupTrayDwellIfNeeded();
        this._sessionUpdated();
        this._hotCornersChanged();

        /*
        this._noMessages = new St.Label({ text: _("No Messages"),
                                          style_class: 'no-messages-label',
                                          x_align: Clutter.ActorAlign.CENTER,
                                          x_expand: true,
                                          y_align: Clutter.ActorAlign.CENTER,
                                          y_expand: true });
        this.actor.add_actor(this._noMessages);
        this._updateNoMessagesLabel();

        this._messageTrayMenuButton = new MessageTrayMenuButton(this);
        this.actor.add_actor(this._messageTrayMenuButton.actor);
        */

        /*
        this._indicator = new MessageTrayIndicator(this);
        Main.layoutManager.trayBox.add_child(this._indicator.actor);
        Main.layoutManager.trackChrome(this._indicator.actor);
        this._grabHelper.addActor(this._indicator.actor);
        */
    },

    close: function() {
        this._escapeTray();
    },

    _setupTrayDwellIfNeeded: function() {
        // If we don't have extended barrier features, then we need
        // to support the old tray dwelling mechanism.
        if (!global.display.supports_extended_barriers()) {
            let pointerWatcher = PointerWatcher.getPointerWatcher();
            pointerWatcher.addWatch(TRAY_DWELL_CHECK_INTERVAL, Lang.bind(this, this._checkTrayDwell));
            this._trayDwelling = false;
            this._trayDwellUserTime = 0;
        }
    },

    _updateNoMessagesLabel: function() {
        // this._noMessages.visible = this._sources.size == 0;
    },

    _sessionUpdated: function() {
        /*
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter) {
            if (this._inCtrlAltTab)
                Main.ctrlAltTabManager.removeGroup(this._summary);
            this._inCtrlAltTab = false;
        } else if (!this._inCtrlAltTab) {
            Main.ctrlAltTabManager.addGroup(this._summary, _("Message Tray"), 'user-available-symbolic',
                                            { focusCallback: Lang.bind(this, this.toggleAndNavigate),
                                              sortGroup: CtrlAltTab.SortGroup.BOTTOM });
            this._inCtrlAltTab = true;
        }
        this._updateState();
        */
    },

    _checkTrayDwell: function(x, y) {
        let monitor = Main.layoutManager.bottomMonitor;
        let shouldDwell = (x >= monitor.x && x <= monitor.x + monitor.width &&
                           y == monitor.y + monitor.height - 1);
        if (shouldDwell) {
            // We only set up dwell timeout when the user is not hovering over the tray
            // (!this._notificationHovered). This avoids bringing up the message tray after the
            // user clicks on a notification with the pointer on the bottom pixel
            // of the monitor. The _trayDwelling variable is used so that we only try to
            // fire off one tray dwell - if it fails (because, say, the user has the mouse down),
            // we don't try again until the user moves the mouse up and down again.
            if (!this._trayDwelling && !this._notificationHovered && this._trayDwellTimeoutId == 0) {
                // Save the interaction timestamp so we can detect user input
                let focusWindow = global.display.focus_window;
                this._trayDwellUserTime = focusWindow ? focusWindow.user_time : 0;

                this._trayDwellTimeoutId = Mainloop.timeout_add(TRAY_DWELL_TIME,
                                                                Lang.bind(this, this._trayDwellTimeout));
                GLib.Source.set_name_by_id(this._trayDwellTimeoutId, '[gnome-shell] this._trayDwellTimeout');
            }
            this._trayDwelling = true;
        } else {
            this._cancelTrayDwell();
            this._trayDwelling = false;
        }
    },

    _onNotificationKeyRelease: function(actor, event) {
        if (event.get_key_symbol() == Clutter.KEY_Escape && event.get_state() == 0) {
            this._expireNotification();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    },

    _expireNotification: function() {
        this._notificationExpired = true;
        this._updateState();
    },

    _closeNotification: function() {
        if (this._notificationState == State.SHOWN) {
            this._closeButton.hide();
            this._notification.emit('done-displaying');
            this._notification.destroy();
        }
    },

    contains: function(source) {
        return this._sources.has(source);
    },

    add: function(source) {
        if (this.contains(source)) {
            log('Trying to re-add source ' + source.title);
            return;
        }

        // Register that we got a notification for this source
        source.policy.store();

        source.policy.connect('enable-changed', Lang.bind(this, this._onSourceEnableChanged, source));
        source.policy.connect('policy-changed', Lang.bind(this, this._updateState));
        this._onSourceEnableChanged(source.policy, source);
    },

    _addSource: function(source) {
        let obj = {
            source: source,
            notifyId: 0,
            destroyId: 0,
            mutedChangedId: 0,
            countChangedId: 0,
        };

        if (source.isClearable)
            this.clearableCount++;

        this._sources.set(source, obj);

        obj.notifyId = source.connect('notify', Lang.bind(this, this._onNotify));
        obj.destroyId = source.connect('destroy', Lang.bind(this, this._onSourceDestroy));
        obj.mutedChangedId = source.connect('muted-changed', Lang.bind(this,
            function () {
                if (source.isMuted)
                    this._notificationQueue = this._notificationQueue.filter(function(notification) {
                        return source != notification.source;
                    });
            }));
        obj.countChangedId = source.connect('count-updated', Lang.bind(this, function() {
            this.emit('indicator-count-updated');
        }));

        this.emit('source-added', source);
        this.emit('indicator-count-updated');

        this._updateNoMessagesLabel();
    },

    _removeSource: function(source) {
        let obj = this._sources.get(source);
        this._sources.delete(source);

        if (source.isClearable)
            this.clearableCount--;

        source.disconnect(obj.notifyId);
        source.disconnect(obj.destroyId);
        source.disconnect(obj.mutedChangedId);
        source.disconnect(obj.countChangedId);

        this.emit('source-removed', source);
        this.emit('indicator-count-updated');

        this._updateNoMessagesLabel();
    },

    getSources: function() {
        return [k for (k of this._sources.keys())];
    },

    _onSourceEnableChanged: function(policy, source) {
        let wasEnabled = this.contains(source);
        let shouldBeEnabled = policy.enable;

        if (wasEnabled != shouldBeEnabled) {
            if (shouldBeEnabled)
                this._addSource(source);
            else
                this._removeSource(source);
        }
    },

    _onSourceDestroy: function(source) {
        this._removeSource(source);
    },

    get hasChatSources() {
        for (let source of this._sources.keys())
            if (source.isChat)
                return true;
        return false;
    },

    get indicatorCount() {
        if (!this._sources.size)
            return 0;

        let count = 0;
        for (let source of this._sources.keys())
            count += source.indicatorCount;
        return count;
    },

    _onNotificationDestroy: function(notification) {
        if (this._notification == notification && (this._notificationState == State.SHOWN || this._notificationState == State.SHOWING)) {
            this._updateNotificationTimeout(0);
            this._notificationRemoved = true;
            this._updateState();
            return;
        }

        let index = this._notificationQueue.indexOf(notification);
        if (index != -1)
            this._notificationQueue.splice(index, 1);
    },

    openTray: function() {
        if (Main.overview.animationInProgress)
            return;

        this._traySummoned = true;
        this._updateState();
    },

    toggle: function() {
        if (Main.overview.animationInProgress)
            return false;

        this._traySummoned = !this._traySummoned;
        this._updateState();
        return true;
    },

    toggleAndNavigate: function() {
        if (!this.toggle())
            return;

        /*
        if (this._traySummoned)
            this._.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false);
        */
    },

    hide: function() {
        this._traySummoned = false;
        this._updateState();
    },

    _onNotify: function(source, notification) {
        if (this._notification == notification) {
            // If a notification that is being shown is updated, we update
            // how it is shown and extend the time until it auto-hides.
            // If a new notification is updated while it is being hidden,
            // we stop hiding it and show it again.
            this._updateShowingNotification();
        } else if (this._notificationQueue.indexOf(notification) < 0) {
            notification.connect('destroy',
                                 Lang.bind(this, this._onNotificationDestroy));
            this._notificationQueue.push(notification);
            this._notificationQueue.sort(function(notification1, notification2) {
                return (notification2.urgency - notification1.urgency);
            });
        }
        this._updateState();
    },

    _hotCornersChanged: function() {
    /*
        let primary = Main.layoutManager.primaryIndex;
        let corner = Main.layoutManager.hotCorners[primary];
        if (corner && corner.actor)
            this._grabHelper.addActor(corner.actor);
    */
    },

    _resetNotificationLeftTimeout: function() {
        this._useLongerNotificationLeftTimeout = false;
        if (this._notificationLeftTimeoutId) {
            Mainloop.source_remove(this._notificationLeftTimeoutId);
            this._notificationLeftTimeoutId = 0;
            this._notificationLeftMouseX = -1;
            this._notificationLeftMouseY = -1;
        }
    },

    _onNotificationHoverChanged: function() {
        if (this._notificationWidget.hover == this._notificationHovered)
            return;

        this._notificationHovered = this._notificationWidget.hover;
        if (this._notificationHovered) {
            // No dwell inside notifications at the bottom of the screen
            // this._cancelTrayDwell();

            this._resetNotificationLeftTimeout();

            if (this._showNotificationMouseX >= 0) {
                let actorAtShowNotificationPosition =
                    global.stage.get_actor_at_pos(Clutter.PickMode.ALL, this._showNotificationMouseX, this._showNotificationMouseY);
                this._showNotificationMouseX = -1;
                this._showNotificationMouseY = -1;
                // Don't set this._pointerInNotification to true if the pointer was initially in the area where the notification
                // popped up. That way we will not be expanding notifications that happen to pop up over the pointer
                // automatically. Instead, the user is able to expand the notification by mousing away from it and then
                // mousing back in. Because this is an expected action, we set the boolean flag that indicates that a longer
                // timeout should be used before popping down the notification.
                /*
                if (this.actor.contains(actorAtShowNotificationPosition)) {
                    this._useLongerNotificationLeftTimeout = true;
                    return;
                }
                */
            }

            this._pointerInNotification = true;
            this._updateState();
        } else {
            // We record the position of the mouse the moment it leaves the tray. These coordinates are used in
            // this._onNotificationLeftTimeout() to determine if the mouse has moved far enough during the initial timeout for us
            // to consider that the user intended to leave the tray and therefore hide the tray. If the mouse is still
            // close to its previous position, we extend the timeout once.
            let [x, y, mods] = global.get_pointer();
            this._notificationLeftMouseX = x;
            this._notificationLeftMouseY = y;

            // We wait just a little before hiding the message tray in case the user quickly moves the mouse back into it.
            // We wait for a longer period if the notification popped up where the mouse pointer was already positioned.
            // That gives the user more time to mouse away from the notification and mouse back in in order to expand it.
            let timeout = this._useLongerNotificationLeftTimeout ? LONGER_HIDE_TIMEOUT * 1000 : HIDE_TIMEOUT * 1000;
            this._notificationLeftTimeoutId = Mainloop.timeout_add(timeout, Lang.bind(this, this._onNotificationLeftTimeout));
            GLib.Source.set_name_by_id(this._notificationLeftTimeoutId, '[gnome-shell] this._onNotificationLeftTimeout');
        }
    },

    _onKeyboardVisibleChanged: function(layoutManager, keyboardVisible) {
        this._keyboardVisible = keyboardVisible;
        this._updateState();
    },

    _onStatusChanged: function(status) {
        if (status == GnomeSession.PresenceStatus.BUSY) {
            // remove notification and allow the summary to be closed now
            this._updateNotificationTimeout(0);
            this._busy = true;
        } else if (status != GnomeSession.PresenceStatus.IDLE) {
            // We preserve the previous value of this._busy if the status turns to IDLE
            // so that we don't start showing notifications queued during the BUSY state
            // as the screensaver gets activated.
            this._busy = false;
        }

        this._updateState();
    },

    _onNotificationLeftTimeout: function() {
        let [x, y, mods] = global.get_pointer();
        // We extend the timeout once if the mouse moved no further than MOUSE_LEFT_ACTOR_THRESHOLD to either side or up.
        // We don't check how far down the mouse moved because any point above the tray, but below the exit coordinate,
        // is close to the tray.
        if (this._notificationLeftMouseX > -1 &&
            y > this._notificationLeftMouseY - MOUSE_LEFT_ACTOR_THRESHOLD &&
            x < this._notificationLeftMouseX + MOUSE_LEFT_ACTOR_THRESHOLD &&
            x > this._notificationLeftMouseX - MOUSE_LEFT_ACTOR_THRESHOLD) {
            this._notificationLeftMouseX = -1;
            this._notificationLeftTimeoutId = Mainloop.timeout_add(LONGER_HIDE_TIMEOUT * 1000,
                                                             Lang.bind(this, this._onNotificationLeftTimeout));
            GLib.Source.set_name_by_id(this._notificationLeftTimeoutId, '[gnome-shell] this._onNotificationLeftTimeout');
        } else {
            this._notificationLeftTimeoutId = 0;
            this._useLongerNotificationLeftTimeout = false;
            this._pointerInNotification = false;
            this._updateNotificationTimeout(0);
            this._updateState();
        }
        return GLib.SOURCE_REMOVE;
    },

    _escapeTray: function() {
        this._pointerInNotification = false;
        this._traySummoned = false;
        this._updateNotificationTimeout(0);
        this._updateState();
    },

    hasVisibleNotification: function() {
        return this._notificationState != State.HIDDEN;
    },

    // All of the logic for what happens when occurs here; the various
    // event handlers merely update variables such as
    // 'this._pointerInNotification', 'this._traySummoned', etc, and
    // _updateState() figures out what (if anything) needs to be done
    // at the present time.
    _updateState: function() {
        // If our state changes caused _updateState to be called,
        // just exit now to prevent reentrancy issues.
        if (this._updatingState)
            return;

        this._updatingState = true;

        // Filter out acknowledged notifications.
        this._notificationQueue = this._notificationQueue.filter(function(n) {
            return !n.acknowledged;
        });

        let hasNotifications = Main.sessionMode.hasNotifications;

        if (this._notificationState == State.HIDDEN) {
            let shouldShowNotification = (hasNotifications && !this._traySummoned);
            let nextNotification = this._notificationQueue[0] || null;
            if (shouldShowNotification && nextNotification) {
                let limited = this._busy || Main.layoutManager.bottomMonitor.inFullscreen;
                let showNextNotification = (!limited || nextNotification.forFeedback || nextNotification.urgency == Urgency.CRITICAL);
                if (showNextNotification)
                    this._showNotification();
            }
        } else if (this._notificationState == State.SHOWN) {
            let expired = (this._userActiveWhileNotificationShown &&
                           this._notificationTimeoutId == 0 &&
                           this._notification.urgency != Urgency.CRITICAL &&
                           !this._notification.focused &&
                           !this._pointerInNotification) || this._notificationExpired;
            let mustClose = (this._notificationRemoved || !hasNotifications || expired || this._traySummoned);

            if (mustClose) {
                let animate = hasNotifications && !this._notificationRemoved;
                this._hideNotification(animate);
            } else if (this._pointerInNotification && !this._notification.expanded) {
                this._expandNotification(false);
            } else if (this._pointerInNotification) {
                this._ensureNotificationFocused();
            }
        }

        if (this._traySummoned)
            this._notificationDrawer.actor.y = -this._notificationDrawer.actor.height;
        else
            this._notificationDrawer.actor.y = 0;

        this._updatingState = false;

        // Clean transient variables that are used to communicate actions
        // to updateState()
        this._notificationExpired = false;
    },

    _tween: function(actor, statevar, value, params) {
        let onComplete = params.onComplete;
        let onCompleteScope = params.onCompleteScope;
        let onCompleteParams = params.onCompleteParams;

        params.onComplete = this._tweenComplete;
        params.onCompleteScope = this;
        params.onCompleteParams = [statevar, value, onComplete, onCompleteScope, onCompleteParams];

        // Remove other tweens that could mess with the state machine
        Tweener.removeTweens(actor);
        Tweener.addTween(actor, params);

        let valuing = (value == State.SHOWN) ? State.SHOWING : State.HIDING;
        this[statevar] = valuing;
    },

    _tweenComplete: function(statevar, value, onComplete, onCompleteScope, onCompleteParams) {
        this[statevar] = value;
        if (onComplete)
            onComplete.apply(onCompleteScope, onCompleteParams);
        this._updateState();
    },

    _showTray: function() {
        /*
        if (!this._grabHelper.grab({ actor: this.actor,
                                     onUngrab: Lang.bind(this, this._escapeTray) })) {
            this._traySummoned = false;
            return false;
        }

        this.emit('showing');
        this._tween(this.actor, '_trayState', State.SHOWN,
                    { y: -this.actor.height,
                      time: ANIMATION_TIME,
                      transition: 'easeOutQuad'
                    });

        */
        return true;
    },

    _onIdleMonitorBecameActive: function() {
        this._userActiveWhileNotificationShown = true;
        this._updateNotificationTimeout(2000);
        this._updateState();
    },

    _showNotification: function() {
        this._notification = this._notificationQueue.shift();

        this._userActiveWhileNotificationShown = this.idleMonitor.get_idletime() <= IDLE_TIME;
        if (!this._userActiveWhileNotificationShown) {
            // If the user isn't active, set up a watch to let us know
            // when the user becomes active.
            this.idleMonitor.add_user_active_watch(Lang.bind(this, this._onIdleMonitorBecameActive));
        }

        this._notificationClickedId = this._notification.connect('done-displaying',
                                                                 Lang.bind(this, this._escapeTray));
        this._notificationUnfocusedId = this._notification.connect('unfocused', Lang.bind(this, function() {
            this._updateState();
        }));
        this._notificationBin.child = this._notification.actor;

        this._notificationWidget.opacity = 0;
        this._notificationWidget.show();

        this._updateShowingNotification();

        let [x, y, mods] = global.get_pointer();
        // We save the position of the mouse at the time when we started showing the notification
        // in order to determine if the notification popped up under it. We make that check if
        // the user starts moving the mouse and _onNotificationHoverChanged() gets called. We don't
        // expand the notification if it just happened to pop up under the mouse unless the user
        // explicitly mouses away from it and then mouses back in.
        this._showNotificationMouseX = x;
        this._showNotificationMouseY = y;
        // We save the coordinates of the mouse at the time when we started showing the notification
        // and then we update it in _notificationTimeout(). We don't pop down the notification if
        // the mouse is moving towards it or within it.
        this._lastSeenMouseX = x;
        this._lastSeenMouseY = y;

        this._resetNotificationLeftTimeout();
    },

    _updateShowingNotification: function() {
        this._notification.acknowledged = true;
        this._notification.playSound();

        // We auto-expand notifications with CRITICAL urgency, or for which the relevant setting
        // is on in the control center.
        if (this._notification.urgency == Urgency.CRITICAL ||
            this._notification.source.policy.forceExpanded)
            this._expandNotification(true);

        // We tween all notifications to full opacity. This ensures that both new notifications and
        // notifications that might have been in the process of hiding get full opacity.
        //
        // We use this._showNotificationCompleted() onComplete callback to extend the time the updated
        // notification is being shown.

        this._tween(this._notificationWidget, '_notificationState', State.SHOWN,
                    { opacity: 255,
                      time: ANIMATION_TIME,
                      transition: 'easeOutQuad',
                      onComplete: this._showNotificationCompleted,
                      onCompleteScope: this
                    });
        this._notificationRevealer.show(true);
   },

    _showNotificationCompleted: function() {
        if (this._notification.urgency != Urgency.CRITICAL)
            this._updateNotificationTimeout(NOTIFICATION_TIMEOUT * 1000);
    },

    _updateNotificationTimeout: function(timeout) {
        if (this._notificationTimeoutId) {
            Mainloop.source_remove(this._notificationTimeoutId);
            this._notificationTimeoutId = 0;
        }
        if (timeout > 0) {
            this._notificationTimeoutId =
                Mainloop.timeout_add(timeout,
                                     Lang.bind(this, this._notificationTimeout));
            GLib.Source.set_name_by_id(this._notificationTimeoutId, '[gnome-shell] this._notificationTimeout');
        }
    },

    _notificationTimeout: function() {
        let [x, y, mods] = global.get_pointer();
        if (y > this._lastSeenMouseY + 10 && !this._notificationHovered) {
            // The mouse is moving towards the notification, so don't
            // hide it yet. (We just create a new timeout (and destroy
            // the old one) each time because the bookkeeping is
            // simpler.)
            this._updateNotificationTimeout(1000);
        } else if (this._useLongerNotificationLeftTimeout && !this._notificationLeftTimeoutId &&
                  (x != this._lastSeenMouseX || y != this._lastSeenMouseY)) {
            // Refresh the timeout if the notification originally
            // popped up under the pointer, and the pointer is hovering
            // inside it.
            this._updateNotificationTimeout(1000);
        } else {
            this._notificationTimeoutId = 0;
            this._updateState();
        }

        this._lastSeenMouseX = x;
        this._lastSeenMouseY = y;
        return GLib.SOURCE_REMOVE;
    },

    _hideNotification: function(animate) {
        this._notificationFocusGrabber.ungrabFocus();

        if (this._notificationExpandedId) {
            this._notification.disconnect(this._notificationExpandedId);
            this._notificationExpandedId = 0;
        }
        if (this._notificationClickedId) {
            this._notification.disconnect(this._notificationClickedId);
            this._notificationClickedId = 0;
        }
        if (this._notificationUnfocusedId) {
            this._notification.disconnect(this._notificationUnfocusedId);
            this._notificationUnfocusedId = 0;
        }

        this._resetNotificationLeftTimeout();

        if (animate) {
            this._tween(this._notificationWidget, '_notificationState', State.HIDDEN,
                        { opacity: 0,
                          time: ANIMATION_TIME,
                          transition: 'easeOutQuad',
                          onComplete: this._hideNotificationCompleted,
                          onCompleteScope: this
                        });
            this._notificationRevealer.hide(true);
        } else {
            Tweener.removeTweens(this._notificationWidget);
            this._notificationWidget.opacity = 0;
            this._notificationState = State.HIDDEN;
            this._hideNotificationCompleted();
            this._notificationRevealer.hide(false);
        }
    },

    _hideNotificationCompleted: function() {
        this._notification.collapseCompleted();

        let notification = this._notification;
        this._notification = null;
        if (notification.isTransient)
            notification.destroy(NotificationDestroyedReason.EXPIRED);

        this._closeButton.hide();
        this._pointerInNotification = false;
        this._notificationRemoved = false;
        this._notificationBin.child = null;
        this._notificationWidget.hide();
    },

    _expandActiveNotification: function() {
        if (!this._notification)
            return;

        this._expandNotification(false);
    },

    _expandNotification: function(autoExpanding) {
        if (!this._notificationExpandedId)
            this._notificationExpandedId =
                this._notification.connect('expanded',
                                           Lang.bind(this, this._onNotificationExpanded));
        // Don't animate changes in notifications that are auto-expanding.
        this._notification.expand(!autoExpanding);

        // Don't focus notifications that are auto-expanding.
        if (!autoExpanding)
            this._ensureNotificationFocused();
    },

    _onNotificationExpanded: function() {
        this._closeButton.show();
    },

    _ensureNotificationFocused: function() {
        this._notificationFocusGrabber.grabFocus();
    },
});
Signals.addSignalMethods(MessageTray.prototype);

const SystemNotificationSource = new Lang.Class({
    Name: 'SystemNotificationSource',
    Extends: Source,

    _init: function() {
        this.parent(_("System Information"), 'dialog-information-symbolic');
    },

    open: function() {
        this.destroy();
    }
});
