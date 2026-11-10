/**
 * dsh-opencode-go-remaining — browser half.
 *
 * Two React contributions, both registered through official slots (no DOM
 * hijacking, no second app root):
 *
 *   conversation.input.right — the always-visible quota pill. It shows the
 *       window that is closest to running out, as whole-percent remaining,
 *       coloured success → warn → error.
 *   shell.overlay — the detail card opened by that pill: three bars (rolling
 *       5h / weekly / monthly) with remaining percent, reset countdown and
 *       reset time, plus refresh and the credential source.
 *
 * Data comes from the host route `/api/opencode-go-remaining/usage`; the pill polls
 * only while the document is visible, and opening the card forces a refresh.
 *
 * Failure policy: rendering must never throw into the shell — a throwing slot
 * entry blanks the seat — so every fetch and formatter degrades to a label.
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-remaining',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    /* ---------------------------------------------------------- constants */

    /** Host route spelling (identical in index.js). */
    const USAGE_API = '/api/opencode-go-remaining/usage';
    /** Version status; POST starts the reinstall. */
    const UPDATE_API = '/api/opencode-go-remaining/update';
    /** Published versions plus the packaged changelog. */
    const VERSIONS_API = '/api/opencode-go-remaining/versions';
    /** Windows in display order. */
    const WINDOWS = ['rolling', 'weekly', 'monthly'];
    /** Poll cadence while the page is visible. */
    const POLL_MS = 60_000;
    /** Card width; also used for viewport clamping. */
    const CARD_WIDTH = 288;

    /* --------------------------------------------------------------- i18n */

    const DICT = {
      zh: {
        title: 'OpenCode Go 余量',
        windows: { rolling: '滚动 5 小时', weekly: '每周', monthly: '每月' },
        short: { rolling: '5h', weekly: '周', monthly: '月' },
        left: (value) => `剩 ${value}%`,
        resetIn: (value) => `${value} 后重置`,
        refresh: '刷新',
        refreshing: '刷新中…',
        updated: (value) => `更新于 ${value}`,
        via: (value) => `数据源：${value}`,
        failed: '读取失败',
        retry: '重试',
        empty: '暂无数据',
        pillTitle: (parts) => `OpenCode Go 余量 · ${parts}`,
        version: (value) => `v${value}`,
        versionsTitle: '版本历史',
        checkingVersions: '正在读取版本…',
        upToDate: '已是最新',
        updateAvailable: (value) => `可更新 v${value}`,
        updateTo: (value) => `更新到 v${value}`,
        updating: '更新中…',
        updateInstalled: (value) => `已更新到 v${value}，重启 DSH 生效`,
        updateFailed: '更新失败',
        localInstall: '本地安装（git pull 更新）',
        gitInstall: 'Git 安装（git pull 更新）',
        notPublished: '尚未发布到 npm',
        noNotes: '无更新说明',
        currentTag: '当前',
        releases: '发布记录',
      },
      en: {
        title: 'OpenCode Go quota',
        windows: { rolling: 'Rolling 5h', weekly: 'Weekly', monthly: 'Monthly' },
        short: { rolling: '5h', weekly: 'W', monthly: 'M' },
        left: (value) => `${value}% left`,
        resetIn: (value) => `resets in ${value}`,
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        updated: (value) => `updated ${value}`,
        via: (value) => `via ${value}`,
        failed: 'Unavailable',
        retry: 'Retry',
        empty: 'No data',
        pillTitle: (parts) => `OpenCode Go quota · ${parts}`,
        version: (value) => `v${value}`,
        versionsTitle: 'Versions',
        checkingVersions: 'Reading versions…',
        upToDate: 'Up to date',
        updateAvailable: (value) => `v${value} available`,
        updateTo: (value) => `Update to v${value}`,
        updating: 'Updating…',
        updateInstalled: (value) => `Updated to v${value}. Restart DSH.`,
        updateFailed: 'Update failed',
        localInstall: 'Local install (git pull)',
        gitInstall: 'Git install (git pull)',
        notPublished: 'Not published to npm yet',
        noNotes: 'No notes',
        currentTag: 'current',
        releases: 'Releases',
      },
    };

    /** Active dictionary; replaced in apply() after the language is known. */
    let L = DICT.en;

    /** Pick zh/en from the Client locale service, the document, or navigator. */
    function detectLanguage(ctx) {
      try {
        const snapshot = ctx?.locale?.getLocale?.();
        const id =
          typeof snapshot === 'string'
            ? snapshot
            : snapshot?.id ?? snapshot?.locale ?? snapshot?.current ?? snapshot?.lang;
        if (typeof id === 'string' && id.length > 0) return id.toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch {
        // Locale service absent or shaped differently: fall through.
      }
      try {
        const lang = document.documentElement.getAttribute('lang') || navigator.language || 'en';
        return String(lang).toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch {
        return 'en';
      }
    }

    /* -------------------------------------------------------------- store */

    const listeners = new Set();
    let state = {
      phase: 'idle',
      data: null,
      error: '',
      fetchedAt: 0,
      busy: false,
      open: false,
      anchor: null,
      /** Host answer about this package's version: { current, latest, available, ... }. */
      update: null,
      /** Version list + notes, fetched when the history opens. */
      versions: null,
      versionsOpen: false,
      versionsBusy: false,
    };

    function getState() {
      return state;
    }

    function setState(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A broken subscriber must not break the others.
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    /** Subscribe one component to the store. */
    function useStore() {
      const [snapshot, setSnapshot] = useState(getState);
      useEffect(() => subscribe(() => setSnapshot(getState())), []);
      return snapshot;
    }

    /* ------------------------------------------------------------- data */

    let inflight = null;

    /** Refresh the payload; concurrent calls share one request. */
    function load(force) {
      if (inflight !== null) return inflight;
      setState({ busy: true });
      inflight = fetch(USAGE_API + (force === true ? '?refresh=1' : ''), {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
        .then((response) => response.json())
        .then((body) => {
          if (body === null || typeof body !== 'object' || body.success === false) {
            throw new Error(body?.error ?? 'usage request failed');
          }
          setState({ phase: 'ready', data: body, error: '', fetchedAt: Date.now(), busy: false });
        })
        .catch((error) => {
          setState({
            phase: state.data === null ? 'error' : 'stale',
            error: String(error?.message ?? error),
            busy: false,
          });
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    }

    /* --------------------------------------------------- versions / update */

    let updateInflight = null;

    /** Ask the host whether a newer release exists (the host caches its answer). */
    function loadUpdate(force) {
      if (updateInflight !== null) return updateInflight;
      updateInflight = fetch(UPDATE_API + (force === true ? '?fresh=1' : ''), {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
        .then((response) => response.json())
        .then((body) => {
          if (body === null || typeof body !== 'object' || body.success === false) return;
          setState({ update: body });
        })
        .catch(() => {
          // A failed check never breaks the card: it keeps the last answer.
        })
        .finally(() => {
          updateInflight = null;
        });
      return updateInflight;
    }

    let versionsInflight = null;

    /** Load the published versions and their notes. */
    function loadVersions(force) {
      if (versionsInflight !== null) return versionsInflight;
      setState({ versionsBusy: true });
      versionsInflight = fetch(VERSIONS_API + (force === true ? '?fresh=1' : ''), {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
        .then((response) => response.json())
        .then((body) => {
          if (body === null || typeof body !== 'object' || body.success === false) {
            throw new Error(body?.error ?? 'versions request failed');
          }
          setState({ versions: body, versionsBusy: false });
        })
        .catch(() => setState({ versions: { versions: [] }, versionsBusy: false }))
        .finally(() => {
          versionsInflight = null;
        });
      return versionsInflight;
    }

    /** Open or close the version history, fetching it the first time. */
    function toggleVersions() {
      const open = !getState().versionsOpen;
      setState({ versionsOpen: open });
      if (!open) return;
      if (getState().update === null) loadUpdate(false);
      if (getState().versions === null) loadVersions(false);
    }

    let updatePoll = null;

    /** Reinstall the newest release, then follow the answer until it settles. */
    function startUpdate() {
      const current = getState().update;
      if (current === null || current.available !== true) return;
      setState({ update: { ...current, phase: 'installing', error: null } });
      fetch(UPDATE_API, { method: 'POST', headers: { accept: 'application/json' }, cache: 'no-store' })
        .then((response) => response.json())
        .then((body) => {
          if (body === null || typeof body !== 'object' || body.success === false) {
            throw new Error(body?.error ?? 'update request failed');
          }
          setState({ update: body });
        })
        .catch((error) => {
          setState({ update: { ...getState().update, phase: 'failed', error: String(error?.message ?? error) } });
        });
      if (updatePoll !== null) clearInterval(updatePoll);
      let ticks = 0;
      updatePoll = setInterval(() => {
        ticks += 1;
        const snapshot = getState();
        if (snapshot.update === null || snapshot.update.phase !== 'installing' || ticks > 40) {
          clearInterval(updatePoll);
          updatePoll = null;
          return;
        }
        loadUpdate(true);
      }, 1500);
    }

    /* --------------------------------------------------------- formatting */

    /** Whole-percent remaining for one window, or null. */
    function remainingOf(window) {
      if (window === null || window === undefined) return null;
      if (typeof window.percent !== 'number' || !Number.isFinite(window.percent)) return null;
      return Math.max(0, Math.min(100, Math.round(100 - window.percent)));
    }

    /** The window closest to exhaustion (highest used percent). */
    function tightest(data) {
      if (data === null || typeof data !== 'object') return null;
      let best = null;
      for (const key of WINDOWS) {
        const value = remainingOf(data[key]);
        if (value === null) continue;
        if (best === null || value < best.left) best = { key, left: value };
      }
      return best;
    }

    /** Token colour for one remaining percentage. */
    function severityColor(left) {
      if (left === null) return 'var(--dsw-alias-state-idle-primary)';
      if (left >= 50) return 'var(--dsw-alias-state-success-primary)';
      if (left >= 20) return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-state-error-primary)';
    }

    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    /** "3h 12m" / "2d 19h" / "45s". */
    function countdown(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return '';
      const target = new Date(iso).getTime();
      if (!Number.isFinite(target)) return '';
      const seconds = Math.max(0, Math.round((target - Date.now()) / 1000));
      if (seconds < 60) return `${seconds}s`;
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor(seconds / 3600) % 24;
      const minutes = Math.floor(seconds / 60) % 60;
      if (days > 0) return `${days}d ${hours}h`;
      if (hours > 0) return `${hours}h ${minutes}m`;
      return `${minutes}m`;
    }

    /** Clock time, with the date when the reset is not today. */
    function clockOf(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
      const today = new Date();
      if (date.toDateString() === today.toDateString()) return time;
      return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
    }

    /** One-line hover summary of all three windows. */
    function hoverSummary(data) {
      const parts = [];
      for (const key of WINDOWS) {
        const left = remainingOf(data?.[key]);
        if (left === null) continue;
        parts.push(`${L.short[key]} ${left}%`);
      }
      return L.pillTitle(parts.join(' · '));
    }

    /* ---------------------------------------------------------------- css */

    const CSS =
      '.ogq-pill{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;margin:0 2px;' +
      'border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;' +
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;' +
      'white-space:nowrap;transition:background .12s ease,color .12s ease}' +
      '.ogq-pill:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}' +
      '.ogq-pill[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);' +
      'border-color:var(--dsw-alias-border-l2)}' +
      '.ogq-dot{width:6px;height:6px;border-radius:50%;flex:none}' +
      '.ogq-card{position:fixed;z-index:2147483000;box-sizing:border-box;padding:12px 14px 10px;border-radius:12px;' +
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));' +
      'color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px rgba(0,0,0,.18);pointer-events:auto;' +
      'font:inherit;font-size:12px;line-height:1.35}' +
      '.ogq-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}' +
      '.ogq-title{font-size:12px;font-weight:600;letter-spacing:.01em}' +
      '.ogq-refresh{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;' +
      'font-size:11px;cursor:pointer;padding:2px 4px;border-radius:6px}' +
      '.ogq-refresh:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}' +
      '.ogq-refresh[disabled]{opacity:.55;cursor:default}' +
      '.ogq-row{display:flex;flex-direction:column;gap:3px;padding:5px 0}' +
      '.ogq-row-line{display:flex;align-items:center;gap:8px}' +
      '.ogq-row-label{flex:none;width:76px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}' +
      '.ogq-bar{display:block;flex:1;height:6px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden}' +
      '.ogq-bar-fill{display:block;height:100%;border-radius:999px;transition:width .25s ease}' +
      '.ogq-row-value{flex:none;width:48px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600}' +
      '.ogq-row-note{padding-left:84px;color:var(--dsw-alias-label-secondary);font-size:11px;' +
      'font-variant-numeric:tabular-nums}' +
      '.ogq-foot{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);' +
      'color:var(--dsw-alias-label-secondary);font-size:11px;display:flex;justify-content:space-between;gap:8px}' +
      '.ogq-error{color:var(--dsw-alias-state-error-primary);word-break:break-word;padding:2px 0 6px}' +
      '.ogq-vers{margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1);' +
      'display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;' +
      'color:var(--dsw-alias-label-secondary);font-size:11px;border-radius:6px}' +
      '.ogq-vers:hover{color:var(--dsw-alias-label-primary)}' +
      '.ogq-vers-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.ogq-vers-go{flex:none;opacity:.75;font-size:12px;line-height:1}' +
      '.ogq-vers[data-tone="update"] .ogq-vers-text{color:var(--dsw-alias-state-success-primary);font-weight:600}' +
      '.ogq-vers[data-tone="error"] .ogq-vers-text{color:var(--dsw-alias-state-error-primary)}' +
      '.ogq-history{margin-top:4px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1);' +
      'max-height:236px;overflow-y:auto;overscroll-behavior:contain}' +
      '.ogq-history-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px}' +
      '.ogq-history-title{font-size:11px;font-weight:600}' +
      '.ogq-history-empty{color:var(--dsw-alias-label-secondary);font-size:11px;padding:4px 0}' +
      '.ogq-update-busy{font-size:11px;color:var(--dsw-alias-label-secondary)}' +
      '.ogq-update{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;' +
      'background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer}' +
      '.ogq-update:hover{background:var(--dsw-alias-bg-layer-2)}' +
      '.ogq-version-list{list-style:none;margin:0;padding:0}' +
      '.ogq-version{padding:5px 0;border-top:1px dashed var(--dsw-alias-border-l1)}' +
      '.ogq-version:first-child{border-top:none;padding-top:2px}' +
      '.ogq-version-line{display:flex;align-items:baseline;gap:6px}' +
      '.ogq-version-no{font-size:11px;font-weight:600}' +
      '.ogq-version-date{color:var(--dsw-alias-label-secondary);font-size:10px;font-variant-numeric:tabular-nums}' +
      '.ogq-version-tag{margin-left:auto;font-size:9px;line-height:1.4;padding:0 5px;border-radius:999px;' +
      'border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}' +
      '.ogq-version[data-current="1"] .ogq-version-no{color:var(--dsw-alias-state-success-primary)}' +
      '.ogq-notes{margin:2px 0 0;padding-left:13px;color:var(--dsw-alias-label-secondary);' +
      'font-size:10.5px;line-height:1.45}' +
      '.ogq-notes li{margin:1px 0}' +
      '.ogq-notes-empty{padding-left:0;opacity:.7}';

    /* ------------------------------------------------------------ pill */

    function Pill() {
      const snapshot = useStore();
      const best = tightest(snapshot.data);
      const left = best === null ? null : best.left;
      const color = severityColor(left);
      const text = left === null ? (snapshot.phase === 'error' ? L.failed : '—') : `${L.short[best.key]} ${left}%`;

      const onClick = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const open = !snapshot.open;
        setState({ open, anchor: open ? { right: rect.right, top: rect.top } : null });
        if (open) {
          load(true);
          loadUpdate(false);
        }
      };

      const updateHint =
        snapshot.update !== null && snapshot.update.available === true ? ` · ${L.updateAvailable(snapshot.update.latest)}` : '';

      return h(
        React.Fragment,
        null,
        h('style', { key: 'css', 'data-ogq': '' }, CSS),
        h(
          'button',
          {
            key: 'pill',
            type: 'button',
            className: 'ogq-pill',
            'data-ogq-pill': '',
            'aria-expanded': snapshot.open ? 'true' : 'false',
            'aria-label': L.title,
            title: hoverSummary(snapshot.data) + updateHint,
            onClick,
          },
          h('span', { className: 'ogq-dot', style: { background: color } }),
          h('span', null, text),
        ),
      );
    }

    /* ------------------------------------------------------------ card */

    /**
     * Place the card above the pill, right-aligned, and keep it inside the
     * viewport. `height` is the measured card height (0 on the first paint);
     * the fallback estimate stops the first frame from jumping.
     */
    function cardStyle(anchor, height) {
      const viewport = typeof window === 'undefined' ? { innerWidth: 1280, innerHeight: 800 } : window;
      if (anchor === null || anchor === undefined) return { right: 16, bottom: 96 };
      const measured = height > 0 ? height : 190;
      const right = Math.max(8, Math.min(viewport.innerWidth - CARD_WIDTH - 8, viewport.innerWidth - anchor.right));
      const above = viewport.innerHeight - anchor.top + 8;
      const ceiling = Math.max(8, viewport.innerHeight - measured - 8);
      return { right, bottom: Math.max(8, Math.min(above, ceiling)) };
    }

    function Row({ windowKey, window }) {
      const left = remainingOf(window);
      const color = severityColor(left);
      const note =
        typeof window?.resetsAt === 'string' && window.resetsAt.length > 0
          ? `${L.resetIn(countdown(window.resetsAt))}${clockOf(window.resetsAt) === '' ? '' : ` · ${clockOf(window.resetsAt)}`}`
          : '';
      return h(
        'div',
        { className: 'ogq-row' },
        h(
          'div',
          { className: 'ogq-row-line' },
          h('span', { className: 'ogq-row-label' }, L.windows[windowKey]),
          h('span', { className: 'ogq-bar' }, h('span', { className: 'ogq-bar-fill', style: { width: `${left ?? 0}%`, background: color } })),
          h('span', { className: 'ogq-row-value', style: { color } }, left === null ? '—' : `${left}%`),
        ),
        note === '' ? null : h('span', { className: 'ogq-row-note' }, note),
      );
    }

    /** One line under the numbers: this package's version and its update state. */
    function VersionRow({ snapshot }) {
      const update = snapshot.update;
      if (update === null) return null;
      const phase = update.phase;
      const text =
        phase === 'installing'
          ? L.updating
          : phase === 'installed'
            ? L.updateInstalled(update.installed ?? update.current)
            : phase === 'failed'
              ? `${L.updateFailed}：${update.error ?? ''}`
              : update.mode === 'local'
                ? L.localInstall
                : update.mode === 'git'
                  ? L.gitInstall
                  : update.available === true
                    ? L.updateAvailable(update.latest)
                    : update.published === false
                      ? L.notPublished
                      : L.upToDate;
      const tone =
        update.available === true && (phase === 'idle' || phase === 'installed')
          ? 'update'
          : phase === 'failed'
            ? 'error'
            : 'plain';
      const toggle = () => toggleVersions();
      return h(
        'div',
        {
          className: 'ogq-vers',
          'data-ogq-vers': '',
          'data-tone': tone,
          role: 'button',
          tabIndex: 0,
          'aria-expanded': snapshot.versionsOpen ? 'true' : 'false',
          title: L.versionsTitle,
          onClick: (event) => {
            event.stopPropagation();
            toggle();
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              toggle();
            }
          },
        },
        h('span', { className: 'ogq-vers-text' }, `${L.version(update.current)} · ${text}`),
        h('span', { className: 'ogq-vers-go' }, snapshot.versionsOpen ? '▾' : '›'),
      );
    }

    /** The expanded history: newest first, with the changelog notes and one update button. */
    function History({ snapshot }) {
      if (!snapshot.versionsOpen) return null;
      const update = snapshot.update;
      const list = snapshot.versions?.versions ?? [];
      const installing = update !== null && update.phase === 'installing';
      const canUpdate = update !== null && update.available === true && !installing;
      return h(
        'div',
        { className: 'ogq-history', 'data-ogq-history': '' },
        h(
          'div',
          { className: 'ogq-history-head' },
          h('span', { className: 'ogq-history-title' }, L.versionsTitle),
          installing
            ? h('span', { className: 'ogq-update-busy' }, L.updating)
            : canUpdate
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ogq-update',
                    onClick: (event) => {
                      event.stopPropagation();
                      startUpdate();
                    },
                  },
                  L.updateTo(update.latest),
                )
              : null,
        ),
        update !== null && update.phase === 'failed'
          ? h('div', { className: 'ogq-error' }, `${L.updateFailed}：${update.error ?? ''}`)
          : null,
        snapshot.versionsBusy || snapshot.versions === null
          ? h('div', { className: 'ogq-history-empty' }, L.checkingVersions)
          : list.length === 0
            ? h('div', { className: 'ogq-history-empty' }, L.noNotes)
            : h(
                'ul',
                { className: 'ogq-version-list' },
                list.slice(0, 8).map((entry) =>
                  h(
                    'li',
                    {
                      key: entry.version,
                      className: 'ogq-version',
                      'data-current': update !== null && entry.version === update.current ? '1' : null,
                    },
                    h(
                      'div',
                      { className: 'ogq-version-line' },
                      h('b', { className: 'ogq-version-no' }, L.version(entry.version)),
                      typeof entry.date === 'string' && entry.date !== ''
                        ? h('span', { className: 'ogq-version-date' }, entry.date.slice(0, 10))
                        : null,
                      update !== null && entry.version === update.current
                        ? h('span', { className: 'ogq-version-tag' }, L.currentTag)
                        : null,
                    ),
                    Array.isArray(entry.notes) && entry.notes.length > 0
                      ? h(
                          'ul',
                          { className: 'ogq-notes' },
                          entry.notes.map((note, index) => h('li', { key: index }, note)),
                        )
                      : h('div', { className: 'ogq-notes ogq-notes-empty' }, L.noNotes),
                  ),
                ),
              ),
      );
    }

    function Card() {
      const snapshot = useStore();
      const card = useRef(null);
      const [height, setHeight] = useState(0);

      // Measure once content settles so the card can clamp inside the viewport.
      useEffect(() => {
        if (!snapshot.open) return;
        const element = card.current;
        if (element === null) return;
        const next = element.getBoundingClientRect().height;
        if (Math.abs(next - height) > 0.5) setHeight(next);
      });

      if (!snapshot.open) return null;
      const data = snapshot.data;
      const rows = data === null ? [] : WINDOWS.map((key) => h(Row, { key, windowKey: key, window: data[key] }));
      const fetched = snapshot.fetchedAt === 0 ? '' : clockOf(new Date(snapshot.fetchedAt).toISOString());

      return h(
        'div',
        {
          ref: card,
          className: 'ogq-card',
          'data-ogq-card': '',
          style: { width: CARD_WIDTH, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto', ...cardStyle(snapshot.anchor, height) },
          role: 'dialog',
          'aria-label': L.title,
        },
        h(
          'div',
          { className: 'ogq-head' },
          h('span', { className: 'ogq-title' }, L.title),
          h(
            'button',
            {
              type: 'button',
              className: 'ogq-refresh',
              disabled: snapshot.busy,
              onClick: (event) => {
                event.stopPropagation();
                load(true);
              },
            },
            snapshot.busy ? L.refreshing : L.refresh,
          ),
        ),
        snapshot.error === ''
          ? null
          : h('div', { className: 'ogq-error' }, data === null ? `${L.failed}：${snapshot.error}` : snapshot.error),
        rows.length === 0 && snapshot.error === '' ? h('div', { className: 'ogq-error' }, L.empty) : rows,
        h(
          'div',
          { className: 'ogq-foot' },
          h('span', null, typeof data?.source === 'string' ? L.via(data.source) : ''),
          h('span', null, fetched === '' ? '' : L.updated(fetched)),
        ),
        h(VersionRow, { snapshot }),
        h(History, { snapshot }),
      );
    }

    /* ------------------------------------------------------------ apply */

    /** Required Client services: the slot registry. */
    const inject = ['slots'];

    /**
     * Mount both contributions and the polling loop.
     * @param ctx - Client plugin context carrying `slots` (and usually `locale`).
     */
    function apply(ctx) {
      L = DICT[detectLanguage(ctx)];
      load(false);
      loadUpdate(false);

      ctx.effect(() => {
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || document.hidden !== true) load(false);
        }, POLL_MS);

        const onVisible = () => {
          if (typeof document !== 'undefined' && document.hidden !== true && getState().data === null) load(false);
        };
        document.addEventListener('visibilitychange', onVisible);

        const onPointerDown = (event) => {
          if (!getState().open) return;
          const target = event.target;
          if (target instanceof Element && (target.closest('[data-ogq-pill]') !== null || target.closest('[data-ogq-card]') !== null)) {
            return;
          }
          setState({ open: false });
        };
        document.addEventListener('pointerdown', onPointerDown, true);

        const onKeyDown = (event) => {
          if (event.key === 'Escape' && getState().open) setState({ open: false });
        };
        document.addEventListener('keydown', onKeyDown, true);

        return () => {
          clearInterval(timer);
          if (updatePoll !== null) {
            clearInterval(updatePoll);
            updatePoll = null;
          }
          document.removeEventListener('visibilitychange', onVisible);
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, 'opencode-go-remaining: polling and dismiss');

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register({ name: 'conversation.input.right', id: 'opencode-go-remaining', order: 20 }, Pill),
          ),
        'opencode-go-remaining: composer pill',
      );

      ctx.effect(() => {
        try {
          return ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register({ name: 'shell.overlay', id: 'opencode-go-remaining-card' }, Card),
          );
        } catch (error) {
          console.warn('[opencode-go-remaining] detail card slot unavailable:', error);
          return () => {};
        }
      }, 'opencode-go-remaining: detail card');
    }

    module.exports = { name: 'opencode-go-remaining', inject, apply };
    return module.exports;
  },
});
