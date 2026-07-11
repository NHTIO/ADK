export const STRESS_THREADS = [
  {
    name: 'T2: turn runner + pipelines',
    turns: [
      'Why does runner.run() return void instead of the final assistant message?',
      'What four invariants guarantee that turnEnd fires even when something goes wrong in my pipeline?',
      'Why do I have four middleware pipelines instead of just named callbacks?',
      'What convention decides whether retrieval belongs in the turn-input or the dispatch-input pipeline?',
      'Why do my dispatch-scoped middlewares run ten times for a ten-iteration dispatch?',
      'If a middleware forgets to call next(), what happens to the ones that haven’t run yet?',
      'And if middleware throws, do the post-step cleanups still run afterward?',
      'How do I pass state between middlewares without a closure leak, and how is turn stash different from dispatch stash?',
      'How do I intentionally refuse to process a turn without emitting an error event?',
    ],
  },
]
