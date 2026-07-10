# CAN Trace Viewer

Browser tool to read a PCAN `.trc` trace, decode signals with PCAN `.sym` symbol
files, and plot them on a shared time axis. Pure front end, no build step, works
offline (uPlot is vendored under `vendor/`).

## Use

Double-click `index.html` (or serve the folder — see below), then:

1. **Symbol files (.sym)** — click/drop one or more (load every bus you need;
   e.g. a battery / inverter / service bus each in its own `.sym`). Enums,
   factors, offsets and units are read from them.
2. **Trace file (.trc)** — click/drop a PCAN trace.
3. Pick signals in the left catalog. Messages that actually appear in the trace
   are listed first; absent ones are greyed. Search by signal, message, or
   `0xID`. Selected signals plot immediately.

Hover the chart for a value tooltip (enum values show their label).

**Layout** — `Single chart` overlays all selected signals on one axis;
`Split per signal` stacks one auto-scaled chart per signal (use it when signals
have very different magnitudes, e.g. a 3000-RPM setpoint next to 0–75 RPM wheel
speeds); `Custom` lets you set how many charts you want and assign signals to
them yourself. In custom mode the legend groups into one column per chart —
**drag a signal chip** to another column to move it, and **right-click a chip**
(any layout) to remove that signal.

**Zoom / pan** — mouse wheel zooms toward the cursor, drag pans the time window,
double-click or the `Reset zoom` button restores full range. In split mode all
charts share one time axis, so zooming/panning one moves them all together.

## Formats

- **`.trc`** — one tab-delimited stream, fields per record:
  `epoch,µs · chan · flags · CAN-ID(hex) · DLC · data-bytes · xtra · ascii`.
  IDs matched to `.sym` messages numerically (standard and extended).
- **`.sym`** — PCAN Symbol Editor v5. `{ENUMS}` + `[Message]` blocks with
  `ID=..h`, `DLC`, and `VAR=name type start,len /f:factor /o:offset /u:"unit"
  /e:ENUM`. Signals decoded Intel / little-endian (PCAN default), with signed
  two's-complement and IEEE-754 float support.

## Files

```
index.html     entry point / layout
app.js         sym + trc parsers, Intel decode, catalog, uPlot chart
styles.css     dark theme
vendor/        uPlot (js + css), vendored for offline use
run.bat        optional: serve over http on :8080
```

## Serve over HTTP (optional)

Not required — `file://` works because files are read via the file picker. Run
`run.bat` only if you prefer an http origin.
