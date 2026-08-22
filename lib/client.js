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

    // ------------------------------------- settings card (meta-config UI)

    /** Number input bound to one staged field. Hint sits under the row so a
     * real explanation can wrap instead of a one-liner beside the box. */
    function NumberRow(props) {
      return h('label', { style: { display: 'grid', gap: 4 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: palette.text } },
          h('span', { style: { width: 220, flex: 'none' } }, props.label),
          h('input', {
            type: 'number', min: props.min ?? 0, step: 1,
            value: props.value,
            disabled: props.disabled === true,
            onChange: event => props.onChange(event.target.value),
            style: {
              width: 90, padding: '4px 8px', borderRadius: 8, fontSize: 13,
              border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text,
            },
          })),
        props.hint
          ? h('p', { style: { margin: 0, fontSize: 12, color: palette.dim, lineHeight: 1.45 } }, props.hint)
          : null)
    }

    /**
     * The Supervisor card in Settings → Plugins: worker-model allowlist (rows
     * with remove buttons + an "add" dropdown fed by /supervisor/models, i.e.
     * the harness model catalog with native modalities) and the three numeric
     * knobs. Edits stage locally; Save writes each changed field through the
     * revision-fenced settings scope. Changes apply live (the spawn tool reads
     * settings at every call) — no restart, no new session.
     */
    function makeSupervisorCard(scope) {
      return function SupervisorCard() {
        const snapshot = React.useSyncExternalStore(
          listener => scope.subscribe(listener),
          () => scope.getSnapshot(),
        )
        const value = snapshot.value ?? {}
        const [draft, setDraft] = React.useState(null)
        const [catalog, setCatalog] = React.useState([])
        const [picker, setPicker] = React.useState('')
        const [saving, setSaving] = React.useState(false)
        const [failed, setFailed] = React.useState(false)

        React.useEffect(() => {
          let live = true
          fetch('/supervisor/models')
            .then(res => res.ok ? res.json() : { models: [] })
            .then(body => { if (live) setCatalog(body.models ?? []) })
            .catch(() => {})
          return () => { live = false }
        }, [])

        const current = draft ?? {
          workerModels: Array.isArray(value.workerModels) ? value.workerModels : [],
          maxParallelWorkers: value.maxParallelWorkers ?? 3,
          wakeMinutes: value.wakeMinutes ?? 5,
          questionWaitMinutes: value.questionWaitMinutes ?? 2,
        }
        const edit = patch => { setDraft({ ...current, ...patch }); setFailed(false) }
        const writable = snapshot.writable === true
        const disabled = !writable || saving

        const save = async () => {
          if (draft === null || saving) return
          setSaving(true)
          setFailed(false)
          try {
            const numeric = (raw, fallback) => {
              const parsed = Number(raw)
              return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback
            }
            await scope.set('workerModels', draft.workerModels)
            await scope.set('maxParallelWorkers', numeric(draft.maxParallelWorkers, 3))
            await scope.set('wakeMinutes', Math.max(5, numeric(draft.wakeMinutes, 5)))
            await scope.set('questionWaitMinutes', Math.max(1, numeric(draft.questionWaitMinutes, 2)))
            setDraft(null)
          } catch {
            setFailed(true)
          }
          setSaving(false)
        }

        const options = catalog.filter(model =>
          !current.workerModels.includes(`${model.provider}/${model.id}`))

        return h('section', {
          style: {
            border: `1px solid ${palette.border}`, borderRadius: 12,
            background: palette.card, padding: '14px 16px',
            display: 'grid', gap: 12,
          },
        },
        h('header', null,
          h('h3', { style: { margin: '0 0 2px', fontSize: 14, color: palette.text } }, 'Supervisor (dsh-supervisor)'),
          h('p', { style: { margin: 0, fontSize: 12, color: palette.dim } },
            'Meta-config for the always-on supervisor. Applies live: the spawn tool re-reads these values on every call — no restart, no new session.')),

        h('div', null,
          h('div', { style: { fontSize: 13, color: palette.text, marginBottom: 6 } }, 'Worker model allowlist'),
          current.workerModels.length === 0
            ? h('p', { style: { margin: '0 0 6px', fontSize: 12, color: palette.dim } },
                'Empty — workers can only inherit the supervisor\'s model.')
            : h('ul', { style: { margin: '0 0 6px', padding: 0, listStyle: 'none', display: 'grid', gap: 4 } },
                current.workerModels.map(entry => h('li', {
                  key: entry,
                  style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: palette.text },
                },
                h('code', { style: { fontSize: 12 } }, entry),
                h('span', { style: { fontSize: 11, color: palette.dim } },
                  (() => {
                    const hit = catalog.find(model => `${model.provider}/${model.id}` === entry)
                    return hit ? `[${hit.modalities.join(',')}]` : ''
                  })()),
                h('button', {
                  disabled,
                  onClick: () => edit({ workerModels: current.workerModels.filter(item => item !== entry) }),
                  style: {
                    marginLeft: 'auto', border: 'none', background: 'transparent',
                    color: palette.dim, cursor: 'pointer', fontSize: 13,
                  },
                  title: 'Remove',
                }, '✕')))),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('select', {
              value: picker,
              disabled,
              onChange: event => setPicker(event.target.value),
              style: {
                flex: 1, padding: '5px 8px', borderRadius: 8, fontSize: 13,
                border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text,
              },
            },
            h('option', { value: '' }, options.length === 0 ? '(no more models in the catalog)' : 'Add a model from the catalog…'),
            options.map(model => h('option', {
              key: `${model.provider}/${model.id}`,
              value: `${model.provider}/${model.id}`,
            }, `${model.provider}/${model.id}  [${model.modalities.join(',')}]`))),
            h('button', {
              disabled: disabled || picker === '',
              onClick: () => {
                edit({ workerModels: [...current.workerModels, picker] })
                setPicker('')
              },
              style: {
                padding: '5px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text,
              },
            }, 'Add'))),

        h(NumberRow, {
          label: 'Max parallel workers (0 = unlimited)', min: 0, disabled,
          value: current.maxParallelWorkers,
          onChange: text => edit({ maxParallelWorkers: text }),
          hint: 'Hard cap on simultaneously open workers. Enforced when the supervisor spawns — a spawn beyond the cap is refused.',
        }),
        h(NumberRow, {
          label: 'Default wakeMinutes', min: 5, disabled,
          value: current.wakeMinutes,
          onChange: text => edit({ wakeMinutes: text }),
          hint: 'How often the supervisor wakes to inspect running workers (minutes). This arms a recurring schedule reminder. Minimum 5 — the harness will not fire a recurring reminder faster than that.',
        }),
        h(NumberRow, {
          label: 'Default questionWaitMinutes', min: 1, disabled,
          value: current.questionWaitMinutes,
          onChange: text => edit({ questionWaitMinutes: text }),
          hint: 'How long the supervisor waits for an answer to a question (minutes) before recording an assumption and continuing the work.',
        }),

        h('footer', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', {
            disabled: disabled || draft === null,
            onClick: () => { void save() },
            style: {
              padding: '6px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              border: `1px solid ${palette.border}`,
              background: draft === null ? 'transparent' : tone.info, color: draft === null ? palette.dim : '#fff',
            },
          }, saving ? 'Saving…' : 'Save'),
          draft !== null ? h('button', {
            disabled: saving,
            onClick: () => { setDraft(null); setFailed(false) },
            style: {
              padding: '6px 12px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
              border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text,
            },
          }, 'Discard') : null,
          failed ? h('span', { style: { fontSize: 12, color: tone.bad } }, 'Save failed — values kept, try again.') : null,
          !writable ? h('span', { style: { fontSize: 12, color: palette.dim } }, 'Settings document is read-only.') : null))
      }
    }

    // ------------------------------------------------------------- plugin

    const inject = ['slots', 'settingsScope']

    function apply(ctx) {
      ctx.slots.inject('conversation.view', () => ctx.slots.register(
        { name: 'conversation.view', id: 'supervisor-feed', order: 50, label: 'Feed' },
        FeedView,
      ))
      const scope = ctx.settingsScope.bind({ namespace: 'dsh-supervisor' })
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
        { name: 'settings.plugin.item', key: 'dsh-supervisor' },
        makeSupervisorCard(scope),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
