# Always On Top

A GNOME Shell extension that pins the focused window above all others with
**Ctrl+Super+T**, and outlines every pinned window with a blue border.

- Press the shortcut again to unpin.
- The border follows the window through moves, resizes, maximize, minimize,
  workspace switches and monitor changes.
- Each border corner is rounded only where the window's own corner is, so it
  hugs libadwaita, GTK3 and window-frame windows alike.
- Pinning from the window menu (Alt+Space, "Always on Top") is outlined too.

Supports GNOME Shell 42 (Ubuntu 22.04). Tested on X11.

## Install

```sh
git clone https://github.com/SailorMoonQ/always-on-top.git
cd always-on-top
glib-compile-schemas schemas/
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/always-on-top@sailormoonq
```

Restart GNOME Shell so it discovers the extension: on X11 press Alt+F2, type
`r`, press Enter; on Wayland log out and back in. Then enable it:

```sh
gnome-extensions enable always-on-top@sailormoonq
```

## Change the shortcut

```sh
dconf write /org/gnome/shell/extensions/always-on-top/toggle-always-on-top "['<Control><Super>t']"
```

## Uninstall

```sh
gnome-extensions disable always-on-top@sailormoonq
rm ~/.local/share/gnome-shell/extensions/always-on-top@sailormoonq
```

## License

GPL-2.0-or-later
