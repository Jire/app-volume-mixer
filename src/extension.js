// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// App Volume Mixer
//
// Adds an "Applications" section to the menu behind the arrow next to the
// output volume slider in Quick Settings. Each app that is playing audio gets
// its own row: click the app icon to mute/unmute it, drag the slider to set
// its volume. Streams from the same app (e.g. several browser tabs) are
// grouped into one row and adjusted together.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

const ALLOW_AMPLIFIED_VOLUME_KEY = 'allow-volume-above-100-percent';
const UNMUTE_DEFAULT_VOLUME = 0.25;

// Apps that open playback streams only to meter levels, not to play sound.
const IGNORED_APP_IDS = new Set([
    'org.gnome.VolumeControl',
    'org.PulseAudio.pavucontrol',
]);

/**
 * Finds the installed app behind a stream, so we can show its real name and
 * icon. Streams carry an application id, a name and an icon name, any of
 * which may be missing or not match a .desktop file exactly.
 *
 * @param {Gvc.MixerStream} stream
 * @returns {Shell.App|null}
 */
function lookupApp(stream) {
    const appSys = Shell.AppSystem.get_default();
    const candidates = [
        stream.get_application_id(),
        stream.get_icon_name(),
        stream.get_name(),
    ].filter(Boolean);

    for (const c of candidates) {
        const app = appSys.lookup_app(`${c}.desktop`) ??
            appSys.lookup_startup_wmclass(c) ??
            appSys.lookup_desktop_wmclass(c) ??
            appSys.lookup_heuristic_basename(`${c.toLowerCase()}.desktop`);
        if (app)
            return app;
    }
    return null;
}

function groupKey(stream) {
    return stream.get_application_id() || stream.get_name() || `stream-${stream.id}`;
}

function isAppStream(stream) {
    return stream instanceof Gvc.MixerSinkInput &&
        !stream.is_event_stream &&
        !stream.is_virtual &&
        !IGNORED_APP_IDS.has(stream.get_application_id());
}

const AppVolumeItem = GObject.registerClass(
class AppVolumeItem extends PopupMenu.PopupBaseMenuItem {
    _init(control) {
        super._init({activate: false, style_class: 'app-mixer-item'});

        this._control = control;
        this._streams = new Map();
        this._app = null;

        // App icon doubles as the mute button; a small badge marks muted apps.
        this._appIcon = new St.Icon({
            style_class: 'app-mixer-app-icon',
            icon_size: 24,
            fallback_icon_name: 'audio-x-generic-symbolic',
        });
        this._muteBadge = new St.Icon({
            style_class: 'app-mixer-mute-badge',
            icon_name: 'audio-volume-muted-symbolic',
            icon_size: 12,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            visible: false,
        });
        const iconStack = new St.Widget({layout_manager: new Clutter.BinLayout()});
        iconStack.add_child(this._appIcon);
        iconStack.add_child(this._muteBadge);

        this._muteButton = new St.Button({
            child: iconStack,
            style_class: 'icon-button flat app-mixer-mute-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._muteButton.connect('clicked', () => this._toggleMute());
        this.add_child(this._muteButton);

        const body = new St.BoxLayout({
            style_class: 'app-mixer-body',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // GNOME 48 replaced St.BoxLayout's `vertical` with `orientation`.
        if ('orientation' in body)
            body.orientation = Clutter.Orientation.VERTICAL;
        else
            body.vertical = true;
        this.add_child(body);

        const labels = new St.BoxLayout({style_class: 'app-mixer-labels'});
        body.add_child(labels);

        this._nameLabel = new St.Label({
            style_class: 'app-mixer-name',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._detailLabel = new St.Label({
            style_class: 'app-mixer-detail',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 150,
        });
        this._percentLabel = new St.Label({
            style_class: 'app-mixer-percent',
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (const l of [this._nameLabel, this._detailLabel])
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        labels.add_child(this._nameLabel);
        labels.add_child(this._detailLabel);
        labels.add_child(this._percentLabel);

        this.slider = new Slider(0);
        this.slider.x_expand = true;
        this._sliderChangedId = this.slider.connect('notify::value',
            () => this._sliderChanged());
        body.add_child(this.slider);
    }

    get isEmpty() {
        return this._streams.size === 0;
    }

    addStream(stream) {
        if (this._streams.has(stream.id))
            return;
        this._streams.set(stream.id, stream);
        stream.connectObject(
            'notify::volume', () => this._sync(),
            'notify::is-muted', () => this._sync(),
            'notify::description', () => this._syncLabels(),
            'notify::name', () => this._syncIdentity(),
            'notify::icon-name', () => this._syncIdentity(),
            this);
        this._syncIdentity();
        this._sync();
    }

    removeStream(id) {
        const stream = this._streams.get(id);
        if (!stream)
            return;
        stream.disconnectObject(this);
        this._streams.delete(id);
        if (!this.isEmpty) {
            this._syncIdentity();
            this._sync();
        }
    }

    setMaxLevel(maxLevel, showMark) {
        this.slider.maximum_value = maxLevel;
        // Slider marks (the 100% tick) only exist on GNOME 49+.
        this.slider.clearMarks?.();
        if (showMark)
            this.slider.addMark?.(1);
        if (!this.isEmpty)
            this._sync();
    }

    _syncIdentity() {
        const first = this._streams.values().next().value;
        if (!first)
            return;

        this._app = lookupApp(first);
        if (this._app) {
            this._appIcon.gicon = this._app.get_icon();
        } else {
            const iconName = first.get_icon_name();
            this._appIcon.gicon = iconName
                ? new Gio.ThemedIcon({name: iconName})
                : new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
        }
        this._syncLabels();
    }

    get _displayName() {
        const first = this._streams.values().next().value;
        return this._app?.get_name() ?? first?.get_name() ?? 'Unknown';
    }

    _syncLabels() {
        const name = this._displayName;
        this._nameLabel.text = name;
        this.slider.accessible_name = `${name} volume`;

        let detail = '';
        if (this._streams.size > 1) {
            detail = `${this._streams.size} streams`;
        } else {
            const desc = this._streams.values().next().value?.get_description();
            if (desc && desc !== name && desc !== this._streams.values().next().value?.get_name())
                detail = desc;
        }
        this._detailLabel.text = detail ? `  ·  ${detail}` : '';
    }

    _sync() {
        const streams = [...this._streams.values()];
        if (!streams.length)
            return;

        const norm = this._control.get_vol_max_norm();
        const muted = streams.every(s => s.is_muted);
        const level = Math.max(...streams.map(s => s.volume)) / norm;

        this.slider.block_signal_handler(this._sliderChangedId);
        this.slider.value = muted ? 0 : level;
        this.slider.unblock_signal_handler(this._sliderChangedId);

        this._percentLabel.text = muted ? 'Muted' : `${Math.round(level * 100)}%`;
        this._muteBadge.visible = muted;
        this._appIcon.opacity = muted ? 110 : 255;
        this._muteButton.accessible_name = muted
            ? `Unmute ${this._displayName}`
            : `Mute ${this._displayName}`;
    }

    _sliderChanged() {
        const volume = Math.round(this.slider.value * this._control.get_vol_max_norm());
        for (const stream of this._streams.values()) {
            let changed;
            if (volume < 1) {
                changed = stream.set_volume(0);
                if (!stream.is_muted)
                    stream.change_is_muted(true);
            } else {
                changed = stream.set_volume(volume);
                if (stream.is_muted)
                    stream.change_is_muted(false);
            }
            if (changed)
                stream.push_volume();
        }
    }

    _toggleMute() {
        const streams = [...this._streams.values()];
        const muted = streams.every(s => s.is_muted);
        for (const stream of streams) {
            if (muted && stream.volume === 0) {
                stream.set_volume(Math.round(
                    UNMUTE_DEFAULT_VOLUME * this._control.get_vol_max_norm()));
                stream.push_volume();
            }
            stream.change_is_muted(!muted);
        }
    }

    destroy() {
        for (const stream of this._streams.values())
            stream.disconnectObject(this);
        this._streams.clear();
        super.destroy();
    }
});

class AppMixer {
    constructor(outputSlider) {
        this._output = outputSlider;
        this._control = getMixerControl();
        this._items = new Map(); // group key -> AppVolumeItem
        this._streamKeys = new Map(); // stream id -> group key

        this._section = new PopupMenu.PopupMenuSection();

        const heading = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            style_class: 'app-mixer-heading',
        });
        heading.add_child(new St.Label({text: 'Applications'}));
        this._section.addMenuItem(heading);

        this._list = new PopupMenu.PopupMenuSection();
        this._section.addMenuItem(this._list);

        // The separator lives in the parent menu (not the section) because
        // menus hide separators at the edge of a section. The parent menu
        // also hides it automatically while our section is hidden.
        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this._output.menu.addMenuItem(this._section, 0);
        this._output.menu.addMenuItem(this._separator, 1);

        // The shell only shows the arrow when there is more than one output
        // device. Keep it visible whenever there are apps to control.
        const originalSync = this._output._sync;
        this._output._sync = function () {
            originalSync.call(this);
            if (this._appMixerHasApps)
                this.menuEnabled = true;
        };

        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.sound'});
        this._settings.connectObject(`changed::${ALLOW_AMPLIFIED_VOLUME_KEY}`,
            () => this._syncMaxLevel(), this);
        this._syncMaxLevel();

        this._control.connectObject(
            'state-changed', () => this._reload(),
            'stream-added', (_c, id) => this._onStreamAdded(id),
            'stream-removed', (_c, id) => this._removeStream(id),
            'stream-changed', (_c, id) => this._onStreamChanged(id),
            this);

        this._reload();
    }

    _syncMaxLevel() {
        const allow = this._settings.get_boolean(ALLOW_AMPLIFIED_VOLUME_KEY);
        this._maxLevel = allow
            ? this._control.get_vol_max_amplified() / this._control.get_vol_max_norm()
            : 1;
        this._showMark = allow;
        for (const item of this._items.values())
            item.setMaxLevel(this._maxLevel, this._showMark);
    }

    _reload() {
        for (const id of [...this._streamKeys.keys()])
            this._removeStream(id, false);

        if (this._control.get_state() === Gvc.MixerControlState.READY) {
            this._syncMaxLevel();
            for (const stream of this._control.get_sink_inputs())
                this._addStream(stream, false);
        }
        this._syncVisibility();
    }

    _onStreamAdded(id) {
        const stream = this._control.lookup_stream_id(id);
        if (stream)
            this._addStream(stream);
    }

    _onStreamChanged(id) {
        const stream = this._control.lookup_stream_id(id);
        const oldKey = this._streamKeys.get(id);
        if (!stream) {
            this._removeStream(id);
            return;
        }
        const wanted = isAppStream(stream) ? groupKey(stream) : null;
        if (wanted === oldKey)
            return;
        if (oldKey)
            this._removeStream(id);
        if (wanted)
            this._addStream(stream);
    }

    _addStream(stream, sync = true) {
        if (!isAppStream(stream) || this._streamKeys.has(stream.id))
            return;

        const key = groupKey(stream);
        let item = this._items.get(key);
        if (!item) {
            item = new AppVolumeItem(this._control);
            item.setMaxLevel(this._maxLevel, this._showMark);
            this._items.set(key, item);
            this._list.addMenuItem(item);
        }
        item.addStream(stream);
        this._streamKeys.set(stream.id, key);

        if (sync)
            this._syncVisibility();
    }

    _removeStream(id, sync = true) {
        const key = this._streamKeys.get(id);
        if (!key)
            return;
        this._streamKeys.delete(id);

        const item = this._items.get(key);
        item?.removeStream(id);
        if (item?.isEmpty) {
            this._items.delete(key);
            item.destroy();
        }

        if (sync)
            this._syncVisibility();
    }

    _syncVisibility() {
        const hasApps = this._items.size > 0;
        this._section.actor.visible = hasApps;
        this._output._appMixerHasApps = hasApps;
        this._output._sync();
    }

    destroy() {
        this._control.disconnectObject(this);
        this._settings.disconnectObject(this);

        for (const item of this._items.values())
            item.destroy();
        this._items.clear();
        this._streamKeys.clear();
        this._section.destroy();
        this._separator.destroy();

        delete this._output._sync;
        delete this._output._appMixerHasApps;
        this._output._sync();
    }
}

export default class AppVolumeMixerExtension extends Extension {
    enable() {
        this._tries = 0;
        this._attach();
    }

    _attach() {
        // Quick Settings builds its indicators asynchronously at startup.
        const output = Main.panel.statusArea.quickSettings?._volumeOutput?._output;
        if (!output) {
            if (this._tries++ < 40) {
                this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    this._timeoutId = 0;
                    this._attach();
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                console.warn(`[${this.uuid}] output volume slider not found`);
            }
            return;
        }
        this._mixer = new AppMixer(output);
    }

    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._mixer?.destroy();
        this._mixer = null;
    }
}
