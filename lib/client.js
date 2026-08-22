/**
 * dsh-supervisor — browser half: the "Feed" view tab.
 *
 * Registers one entry into the shipped `conversation.view` ring (the native
 * view-tab slot that already holds Chat and Trajectory), so every session gains
 * a "Feed" tab rendering the supervisor's run at a glance: goal, workers,
 * progress timeline, open questions, action changelog, notes, mission report.
 *
 * Native-first: the goal comes from the host-computed `goal` projection
 * (`useProjection`, the same feed the shipped GoalBar reads); workers come from
 * the `subagent.list` RPC; the `.agi/` files come from this package's own
 * host route (`/supervisor/feed`, lib/index.js).
 *
 * This file is the loader's lazy-CJS factory artifact, hand-written (the
 * in-repo tsdown preset is not published; docs/cookbook/adding-a-settings-card
 * documents reproducing the format). No JSX — React.createElement only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-supervisor',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement

    // ------------------------------------------------------------- wire

    /** POST /api/<method> with the client-request envelope; null on any failure. */
    async function rpc(method, payload) {
      try {
        const res = await fetch(`/api/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: `feed-${Math.random().toString(36).slice(2, 10)}`,
            method,
            payload,
          }),
        })
        const body = await res.json()
        return body?.result?.ok === true ? body.result.value : null
      } catch {
        return null
      }
    }

    async function fetchFeed(ws) {
      try {
        const res = await fetch(`/supervisor/feed?ws=${encodeURIComponent(ws)}`)
        if (!res.ok) return { missing: true, status: res.status }
        return await res.json()
      } catch {
        return null
      }
    }

    // ------------------------------------------------------------- bits

    const palette = {
      text: 'var(--dsw-alias-label-primary, #ddd)',
      dim: 'var(--dsw-alias-label-tertiary, #888)',
      border: 'var(--dsw-alias-border-l1, #3333)',
      card: 'var(--dsw-specific-tip, rgba(127,127,127,.06))',
    }

    const tone = {
      ok: '#2f9e6e', warn: '#c98a1b', bad: '#c0504d', idle: '#7a7a7a', info: '#4a7dbd',
    }

    function timeAgo(ms) {
      if (typeof ms !== 'number' || !isFinite(ms)) return ''
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (s < 60) return `${s}s ago`
      if (s < 3600) return `${Math.round(s / 60)}m ago`
      if (s < 86400) return `${Math.round(s / 3600)}h ago`
      return `${Math.round(s / 86400)}d ago`
    }

    function tsLabel(value) {
      if (typeof value === 'string') {
        const parsed = Date.parse(value)
        if (isFinite(parsed)) return new Date(parsed).toLocaleTimeString()
        return value
      }
      if (typeof value === 'number') return new Date(value).toLocaleTimeString()
      return ''
    }

    function Pill(props) {
      return h('span', {
        style: {
          display: 'inline-block', padding: '1px 8px', borderRadius: 999,
          fontSize: 11, fontWeight: 600, lineHeight: '16px',
          color: '#fff', background: props.color ?? tone.idle,
          textTransform: 'uppercase', letterSpacing: '.4px',
        },
      }, props.children)
    }

    function Card(props) {
      return h('section', {
        style: {
          border: `1px solid ${palette.border}`, borderRadius: 12,
          background: palette.card, padding: '12px 14px',
          minWidth: 0, gridColumn: props.wide === true ? '1 / -1' : undefined,
        },
      },
      h('header', {
        style: {
          display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8,
        },
      },
      h('h3', {
        style: {
          margin: 0, fontSize: 12, fontWeight: 700, color: palette.dim,
          textTransform: 'uppercase', letterSpacing: '.6px',
        },
      }, props.title),
      props.badge ?? null,
      ),
      props.children)
    }

    function Empty(props) {
      return h('p', { style: { margin: 0, color: palette.dim, fontSize: 13 } },
        props.children)
    }

    function Mono(props) {
      return h('pre', {
        style: {
          margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          font: '12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace',
          color: palette.text, maxHeight: props.max ?? 260, overflow: 'auto',
        },
      }, props.children)
    }

    function Details(props) {
      return h('details', { style: { marginTop: 6 } },
        h('summary', {
          style: { cursor: 'pointer', fontSize: 12, color: palette.dim, userSelect: 'none' },
        }, props.summary),
        h('div', { style: { marginTop: 6 } }, props.children))
    }

    // ------------------------------------------------------------- cards

    function GoalCard(goal) {
      const phaseColor = { active: tone.ok, paused: tone.warn, blocked: tone.bad, completed: tone.info }
      if (goal == null) {
        return h(Card, { title: 'Goal' },
          h(Empty, null, 'No active goal — the GoalBar above the chat input appears when one is created.'))
      }
      return h(Card, { title: 'Goal', badge: h(Pill, { color: phaseColor[goal.phase] ?? tone.idle }, String(goal.phase ?? 'unknown')) },
        h('p', { style: { margin: '0 0 6px', fontSize: 14, lineHeight: 1.5, color: palette.text } },
          String(goal.objective ?? '')),
        h('p', { style: { margin: 0, fontSize: 12, color: palette.dim } },
          `rev ${goal.revision ?? '?'} · rounds ${goal.roundsStarted ?? 0}/${goal.maxGoalRounds ?? '∞'}`
          + (goal.blockedReason ? ` · blocked: ${goal.blockedReason}` : '')
          + (typeof goal.updatedAt === 'number' ? ` · updated ${timeAgo(goal.updatedAt)}` : '')))
    }

    function WorkersCard(workers, feed) {
      const entries = Array.isArray(workers?.entries) ? workers.entries.filter(e => e.kind === 'child') : []
      const outcomes = new Map()
      for (const sub of feed?.subagents ?? []) outcomes.set(sub.name, sub)
      const dot = (activity) => h('span', {
        style: {
          display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 8,
          background: activity === 'active' ? tone.ok : tone.idle, flex: 'none',
        },
      })
      return h(Card, { title: 'Workers', badge: h(Pill, { color: entries.some(e => e.activity === 'active') ? tone.ok : tone.idle }, `${entries.length}`) },
        entries.length === 0
          ? h(Empty, null, 'No workers spawned from this session.')
          : h('ul', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 } },
              entries.map(entry => h('li', {
                key: entry.id,
                style: { display: 'flex', alignItems: 'center', fontSize: 13, color: palette.text, minWidth: 0 },
              },
              dot(entry.activity),
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                String(entry.label ?? entry.id)),
              h('span', { style: { marginLeft: 'auto', paddingLeft: 8, fontSize: 11, color: palette.dim, flex: 'none' } },
                `${entry.activity ?? '?'} · ${entry.mode ?? ''}`)))),
        (feed?.subagents ?? []).filter(sub => sub.outcome != null).map(sub =>
          h(Details, { key: sub.name, summary: `outcome — ${sub.name}` },
            h(Mono, { max: 220 }, sub.outcome.text))))
    }

    function ProgressCard(progress) {
      const items = Array.isArray(progress) ? progress.slice(-30).reverse() : []
      return h(Card, { title: 'Progress', wide: false },
        items.length === 0
          ? h(Empty, null, 'Nothing in .agi/progress.jsonl yet.')
          : h('ol', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 } },
              items.map((item, index) => h('li', {
                key: index,
                style: { display: 'flex', gap: 10, fontSize: 13, lineHeight: 1.45, color: palette.text },
              },
              h('span', { style: { color: palette.dim, flex: 'none', font: '11px/1.6 ui-monospace, monospace' } },
                tsLabel(item.ts)),
              h('span', null, String(item.text ?? JSON.stringify(item)))))))
    }

    function QuestionsCard(questions) {
      const items = Array.isArray(questions) ? questions.slice(-20).reverse() : []
      const color = (status) => status === 'answered' ? tone.ok : status === 'assumed' ? tone.warn : tone.info
      return h(Card, { title: 'Questions' },
        items.length === 0
          ? h(Empty, null, 'No questions asked.')
          : h('ul', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 } },
              items.map((item, index) => h('li', { key: index, style: { fontSize: 13, color: palette.text } },
                h(Pill, { color: color(item.status) }, String(item.status ?? '?')),
                h('span', { style: { marginLeft: 8 } },
                  String(item.question ?? item.text ?? item.id ?? JSON.stringify(item))),
                item.assumption
                  ? h('div', { style: { marginTop: 2, fontSize: 12, color: palette.dim } }, `assumed: ${item.assumption}`)
                  : null))))
    }

    function ChangelogCard(changelog) {
      const items = Array.isArray(changelog) ? changelog.slice(-40).reverse() : []
      const color = (action) => (
        action === 'spawn' ? tone.ok
        : action === 'kill' ? tone.bad
        : action === 'steer' ? tone.warn
        : action === 'verify' || action === 'deliver' ? tone.info
        : tone.idle)
      return h(Card, { title: 'Changelog', wide: true },
        items.length === 0
          ? h(Empty, null, 'No consequential actions logged.')
          : h('ul', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 7 } },
              items.map((item, index) => h('li', {
                key: index,
                style: { display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 13, color: palette.text },
              },
              h('span', { style: { color: palette.dim, flex: 'none', font: '11px/1.6 ui-monospace, monospace' } },
                tsLabel(item.ts)),
              h(Pill, { color: color(item.action) }, String(item.action ?? '?')),
              h('span', { style: { minWidth: 0 } }, String(item.summary ?? JSON.stringify(item)))))))
    }

    function DocumentCard(title, doc) {
      return h(Card, { title, badge: doc ? h('span', { style: { fontSize: 11, color: palette.dim } }, timeAgo(doc.mtime)) : null },
        doc == null
          ? h(Empty, null, `No ${title.toLowerCase()} file.`)
          : h(Mono, { max: 340 }, doc.text))
    }

    // ------------------------------------------------------------- view

    function FeedView(props) {
      const goal = props.useProjection('goal')
      const sessionId = props.sessionId
      const [cwd, setCwd] = React.useState(null)
      const [feed, setFeed] = React.useState(null)
      const [workers, setWorkers] = React.useState(null)
      const [tick, setTick] = React.useState(0)

      React.useEffect(() => {
        const timer = setInterval(() => setTick(value => value + 1), 5000)
        return () => clearInterval(timer)
      }, [])

      React.useEffect(() => {
        let live = true
        rpc('session.list', {}).then((value) => {
          if (!live || value == null) return
          const row = (value.items ?? []).find(item => item.sessionId === sessionId)
          if (row?.cwd) setCwd(row.cwd)
        })
        return () => { live = false }
      }, [sessionId])

      React.useEffect(() => {
        if (cwd == null) return
        let live = true
        fetchFeed(cwd).then(value => { if (live) setFeed(value) })
        rpc('subagent.list', { parentSessionId: sessionId }).then(value => { if (live) setWorkers(value) })
        return () => { live = false }
      }, [cwd, sessionId, tick])

      const body = cwd == null
        ? h(Empty, null, 'Resolving the session workspace…')
        : feed == null
          ? h(Empty, null, 'Loading feed…')
          : feed.missing === true
            ? h(Empty, null, `This workspace has no .agi/ directory (${cwd}) — the Feed lights up for supervisor workspaces.`)
            : h(React.Fragment, null,
                h('div', {
                  style: {
                    display: 'grid', gap: 12,
                    gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
                    alignItems: 'start',
                  },
                },
                GoalCard(goal),
                WorkersCard(workers, feed),
                ProgressCard(feed.progress),
                QuestionsCard(feed.questions),
                ChangelogCard(feed.changelog),
                DocumentCard('Mission report', feed.missionReport),
                DocumentCard('Notes', feed.notes),
                ),
                h(Details, { summary: 'GOAL.md (durable statement)' },
                  feed.goal == null ? h(Empty, null, 'No GOAL.md.') : h(Mono, { max: 400 }, feed.goal.text),
                  feed.amendments != null ? h(Mono, { max: 200 }, feed.amendments.text) : null))

      return h('div', {
        style: {
          height: '100%', overflow: 'auto', padding: '14px 18px 28px',
          boxSizing: 'border-box',
        },
      },
      h('header', {
        style: {
          display: 'flex', alignItems: 'baseline', gap: 10, margin: '2px 0 14px',
          color: palette.dim, fontSize: 12,
        },
      },
      h('strong', { style: { fontSize: 13, color: palette.text } }, 'Supervisor Feed'),
      cwd != null ? h('code', { style: { fontSize: 11 } }, cwd) : null,
      feed?.generatedAt != null
        ? h('span', { style: { marginLeft: 'auto' } }, `refreshed ${timeAgo(feed.generatedAt)}`)
        : null,
      ),
      body)
    }

    // ------------------------------------------------------------- plugin

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('conversation.view', () => ctx.slots.register(
        { name: 'conversation.view', id: 'supervisor-feed', order: 50, label: 'Feed' },
        FeedView,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
