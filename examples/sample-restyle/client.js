window.__ModuleLoader__.load({
  id: 'dsh-raw-agent-sample-restyle',
  factory(require) {
    // A sample DSH client plugin that restyles dsh-raw-agent through its public restyle points and
    // its `rawAgentClient` service (docs/plugin-api.md). Plain JavaScript in DSH's module-loader
    // format, so it needs no build step. React comes from DSH's shared module table.
    //
    // It does three things:
    // 1. It shadows our context pill (`conversation.composer.dock`, id `raw-agent-context`) with a
    //    smaller pill of its own, fed by `rawAgentClient.onEvent` (R9.1).
    // 2. It fills our slot `raw-agent.controls.extra` with a "Sample" button. Its panel calls every
    //    `rawAgentClient` method (R9.2).
    // 3. It never answers an ask and never sends text without the user: send, steer and side
    //    questions need a grant token the user created and pasted into the panel.
    const React = require('react');
    const h = React.createElement;

    const PILL_SLOT = 'conversation.composer.dock';
    const PILL_ID = 'raw-agent-context';
    const EXTRA_SLOT = 'raw-agent.controls.extra';
    const EXTRA_ID = 'sample-restyle-button';
    /** Below our default priority 0, so this entry renders instead of ours. */
    const SHADOW_PRIORITY = -1;

    const TEXTS = {
      composer: 'Explain the last change in plain words.',
      'side-question': 'What did we decide so far?',
      send: 'Sample plugin: reply with one word, please.',
      steer: 'Sample plugin: keep it short, please.',
      question: 'In one sentence: what is this session about?',
    };

    /** A refusal from our service, also one made by another bundle's copy of the error class. */
    function refusal(error) {
      if (error && error.name === 'RawAgentServiceError' && typeof error.code === 'string')
        return `Refused (${error.code}): ${error.message}`;
      return `Failed: ${error && error.message ? error.message : String(error)}`;
    }

    function compact(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
      return String(n);
    }

    /** The pill text from the latest `state` and `usage` events. Unknown numbers are left out. */
    function pillText(state, usage) {
      if (!state) return undefined;
      const parts = [];
      if (usage && usage.compacting) parts.push('compacting');
      else if (usage && usage.context) parts.push(`ctx ${Math.round(usage.context.percent)}%`);
      const tokens = compact(usage && usage.tokens);
      if (tokens) parts.push(`${tokens} tok`);
      if (usage && typeof usage.costUsd === 'number') parts.push(`$${usage.costUsd.toFixed(2)}`);
      if (state.busy) parts.push('working');
      else if (state.waitingForUser > 0) parts.push('waiting for you');
      if (parts.length === 0) parts.push(state.running ? 'idle' : 'not started');
      return parts.join(' · ');
    }

    /** One action per `rawAgentClient` method. Each resolves to a line for the panel. */
    function createDemo(svc, sessionId) {
      const run = (promise, done) => promise.then(done, refusal);
      return {
        info: () =>
          run(svc.sessionInfo(sessionId), (info) => {
            if (!info) return 'Not a raw-agent session.';
            const kinds = svc.backends.map((b) => b.displayName).join(', ') || info.backend.displayName;
            const mode = info.mode ? `, mode ${info.mode}` : '';
            return `${info.backend.displayName}: process ${info.process}${mode}, ${info.backgroundTasks} background task(s). Backends seen: ${kinds}.`;
          }),
        prefill: (target) =>
          run(svc.prefill(sessionId, TEXTS[target], target), (ok) =>
            ok ? 'The text is in the box. Press Enter to send it.' : 'Not a raw-agent session.',
          ),
        interrupt: () => run(svc.interrupt(sessionId), () => 'Stop sent. Background tasks keep running.'),
        send: (grant) => run(svc.send(sessionId, TEXTS.send, grant), (r) => `Sent as message ${r.messageId}.`),
        steer: (grant) => run(svc.steer(sessionId, TEXTS.steer, grant), (r) => `Steered as message ${r.messageId}.`),
        ask: (grant) =>
          run(svc.askSideQuestion(sessionId, TEXTS.question, grant), (answer) =>
            answer === null ? 'No answer.' : `Answer: ${answer}`,
          ),
      };
    }

    /** Follow one session's events into React state. */
    function useSessionEvents(svc, sessionId) {
      const [seen, setSeen] = React.useState({ state: undefined, usage: undefined });
      React.useEffect(() => {
        if (!sessionId) return undefined;
        return svc.onEvent(sessionId, (e) => {
          if (e.type === 'state') setSeen((s) => ({ ...s, state: e.info }));
          else if (e.type === 'usage') setSeen((s) => ({ ...s, usage: e.usage }));
          else if (e.type === 'ended') setSeen({ state: undefined, usage: undefined });
        });
      }, [svc, sessionId]);
      return seen;
    }

    const pillStyle = {
      font: '12px/1.6 var(--raw-agent-mono, ui-monospace, monospace)',
      padding: '0 8px',
      borderRadius: 4,
      border: '1px dashed var(--raw-agent-accent, currentColor)',
      color: 'var(--raw-agent-text, inherit)',
      whiteSpace: 'nowrap',
    };
    const buttonStyle = {
      font: 'inherit',
      fontSize: 12,
      padding: '1px 6px',
      borderRadius: 4,
      border: '1px solid var(--raw-agent-border, currentColor)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    };
    const panelStyle = {
      position: 'absolute',
      bottom: '100%',
      left: 0,
      zIndex: 10,
      width: 320,
      padding: 8,
      marginBottom: 4,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      fontSize: 12,
      borderRadius: 6,
      border: '1px solid var(--raw-agent-border, currentColor)',
      background: 'var(--raw-agent-surface, Canvas)',
      color: 'var(--raw-agent-text, CanvasText)',
    };

    function makeComponents(svc) {
      /** Our context pill, shadowed: a dashed one-line pill. Nothing in sessions that are not ours. */
      function SamplePill(props) {
        const { state, usage } = useSessionEvents(svc, props.sessionId);
        const text = pillText(state, usage);
        if (!text) return null;
        return h(
          'span',
          { 'data-sample-restyle': 'pill', style: pillStyle, title: 'Restyled by the sample plugin' },
          text,
        );
      }

      /** Fills `raw-agent.controls.extra`: a button with a panel that calls every service method. */
      function SampleButton(props) {
        const sessionId = props.sessionId;
        const [open, setOpen] = React.useState(false);
        const [grant, setGrant] = React.useState('');
        const [line, setLine] = React.useState('');
        const demo = React.useMemo(() => createDemo(svc, sessionId), [sessionId]);
        const act = (label, fn) =>
          h(
            'button',
            {
              type: 'button',
              style: buttonStyle,
              'data-sample-restyle': `action-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`,
              onClick: () => {
                setLine('…');
                void fn().then(setLine);
              },
            },
            label,
          );
        React.useEffect(() => {
          if (open) void demo.info().then(setLine);
        }, [open, demo]);
        return h(
          'span',
          { style: { position: 'relative' }, 'data-sample-restyle': 'extra' },
          h(
            'button',
            { type: 'button', style: buttonStyle, 'aria-expanded': open, onClick: () => setOpen(!open) },
            'Sample',
          ),
          open &&
            h(
              'span',
              { style: panelStyle, role: 'dialog', 'aria-label': 'Sample plugin' },
              h('strong', null, 'Sample plugin'),
              h(
                'span',
                null,
                'Prefill and Stop need nothing. Send, Steer and Side question need a grant token from "Agent plugin access".',
              ),
              h('input', {
                type: 'password',
                placeholder: 'Grant token (rag1_…), kept in this page only',
                value: grant,
                style: { font: 'inherit' },
                onChange: (e) => setGrant(e.currentTarget.value),
              }),
              h(
                'span',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                act('Info', demo.info),
                act('Prefill composer', () => demo.prefill('composer')),
                act('Prefill side question', () => demo.prefill('side-question')),
                act('Stop turn', demo.interrupt),
                act('Send', () => demo.send(grant)),
                act('Steer', () => demo.steer(grant)),
                act('Side question', () => demo.ask(grant)),
              ),
              h('span', { role: 'status', 'data-sample-restyle': 'result' }, line),
            ),
        );
      }

      return { SamplePill, SampleButton };
    }

    return {
      name: 'dsh-raw-agent-sample-restyle-client',
      // A hard dependency: this plugin runs only while dsh-raw-agent provides its service.
      inject: ['slots', 'rawAgentClient'],
      apply(ctx) {
        const svc = ctx.rawAgentClient;
        if (!svc || svc.apiVersion !== 1) {
          console.warn('[sample-restyle] rawAgentClient API version 1 not found; doing nothing');
          return;
        }
        const { SamplePill, SampleButton } = makeComponents(svc);
        // 1. Shadow our context pill: same slot, same id, lower priority.
        ctx.slots.inject(PILL_SLOT, () =>
          ctx.slots.register(
            {
              name: PILL_SLOT,
              id: PILL_ID,
              priority: SHADOW_PRIORITY,
              inject: (sessionId) => ({ sessionId }),
            },
            SamplePill,
          ),
        );
        // 2. Fill our slot. The owner props carry the session id; `inject` gets it too.
        ctx.slots.inject(EXTRA_SLOT, () =>
          ctx.slots.register(
            { name: EXTRA_SLOT, id: EXTRA_ID, inject: (sessionId) => (sessionId ? { sessionId } : {}) },
            SampleButton,
          ),
        );
      },
      // For tests and for readers; DSH ignores these fields.
      sample: {
        createDemo,
        pillText,
        makeComponents,
        PILL_SLOT,
        PILL_ID,
        EXTRA_SLOT,
        EXTRA_ID,
        SHADOW_PRIORITY,
        TEXTS,
      },
    };
  },
});
