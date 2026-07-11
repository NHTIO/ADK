// ADVERSARIAL-EDGE corpus for the Token Thrift flagship agent — the "happy but adversarial" counterpart
// to the hostile corpus. These users are WELL-INTENTIONED: they are not trying to break the loop, but
// their legitimate needs are genuinely hard and stress the machinery the same mechanisms the hostile
// corpus attacks by force. Expected outcome is mostly SUCCESS, but along the way these threads exercise
// deep multi-tool loops, multi-page synthesis, the answer-kind planner across kinds back-to-back, honest
// capacity-scoping of a truly exhaustive-but-answerable request, re-reading a prior artifact, and
// utility/compute turns interleaved with doc turns. If the happy corpus proves breadth and the hostile
// corpus proves the rails hold, this corpus proves the machinery still lands the answer when a sincere
// user leans hard on it. Each thread is a fresh conversation; turns WITHIN a thread build on each other.
//
// Edge-class → thread mapping:
//   E1  Exhaustive-but-answerable   — a legitimately complete request (capacity_scoped: honest scope + cite the page that covers it in full)
//   E2  Multi-axis comparison       — compare X and Y and Z on three named axes (multi-page synthesis, one focused answer)
//   E3  Multi-page synthesis        — an answer that only exists by reading several pages and tying them together
//   E4  Re-read a prior artifact    — a follow-up that legitimately needs re-reading the earlier search result
//   E5  Prose vs cited, back-to-back— a conversational turn then a doc-cited turn then a rhetorical one (answer-kind switching)
//   E6  Compute interleaved w/ docs — calculate/date/utility-tool turns woven between real doc questions (tool_computed vs doc_cited)
//   E7  Precise narrow follow-ups   — a broad opener that narrows to a specific citable detail over several turns
export const EDGE_THREADS = [
  {
    name: 'E1: exhaustive-but-answerable — capacity-scoped honest cite',
    turns: [
      'I want the complete picture: walk me through every stage of a single turn, end to end, and where my code plugs into each one.',
      'That is a lot — is there a single page that lays all of this out in full that I can bookmark?',
      'Now do the same completeness for the four middleware pipelines: what each one owns and why the split.',
      'And of those four, which one owns retrieval, and is there a page I can cite for that specifically?',
      'Perfect — is all of that on one page too, or do I need to bookmark several?',
    ],
  },
  {
    name: 'E2: multi-axis comparison — three batteries on three axes',
    turns: [
      'Compare the Ollama, OpenAI-chat-completions, and LiteRT-LM batteries on three axes: where the model runs, whether they need a running process, and what generation parameters differ.',
      'Of those three, which is the right pick if I want Gemma running fully on-device in a browser tab, and what is the one limitation I should know before I try other model families?',
      'And for that on-device pick, what shared contract makes it behave the same as the transformers.js battery?',
      'Last thing on this — if I instead wanted the OpenAI battery to hit a self-hosted proxy rather than the cloud, what changes?',
      'And can I run the exact same ONNX model in both Node and the browser without rewriting my code?',
      'Summarize the whole comparison as a short recommendation for a hobby project running locally.',
    ],
  },
  {
    name: 'E3: multi-page synthesis — thesis + overflow + budget tied together',
    turns: [
      'Explain how token thrift, artifacts, and the context-window budget cooperate to keep a small model from overflowing — I know these are separate pages, I want them tied together.',
      'Given that, what is the single thing that actually makes the dispatch loop terminate, and how does it relate to the budget you just described?',
      'So if I only had time to get one of those three mechanisms right, which one matters most and why?',
      'And where does the subtractive pass fit into that — is it the same thing as the budget or a separate lever?',
    ],
  },
  {
    name: 'E4: re-read a prior artifact — follow-up needs the earlier result',
    turns: [
      'What are the core data primitives the ADK threads through every turn?',
      'From that same list, which one carries a checksum on its results field, and why does the checksum matter?',
      "And out of the ones you found, which is the right primitive to store the model's reasoning trace separately from dialogue?",
      'One more from that list — which primitive lets me know how many tokens a piece of content is worth without calling the provider tokenizer?',
      'And how do I declare where a retrieved piece of content came from so the model knows how much to trust it?',
    ],
  },
  {
    name: 'E5: answer-kind switching — conversational, then cited, then rhetorical',
    turns: [
      'Hey, thanks for the help so far — quick sanity check before I keep going, you are the ADK docs assistant, right?',
      'Great. So concretely: how do I add a human approval step before a tool executes?',
      'Honestly that gate mechanism seems like it could hang a turn forever if nobody clicks approve — does that not worry you?',
      'Fair. So concretely, how do I persist a pending approval across a process restart so it survives a deploy?',
      'And can I serialize a live gate that is currently awaiting resolution, then deserialize it later?',
    ],
  },
  {
    name: 'E6: compute interleaved with docs — tool_computed and doc_cited alternating',
    turns: [
      'If a dispatch runs 12 iterations and each one adds roughly 850 tokens of tool output, how many tokens is that before any shedding?',
      'Right — so which mechanism in ADK keeps that number from actually landing in the window?',
      'What is 2^20, and is that roughly the byte ceiling people mean when they say the in-browser 4GB wall?',
      'Okay, back to docs: why is that 4GB ceiling a wasm32 limit rather than a WebGPU one?',
      'And numerically — if a model weight file is 3.2 GB, how many megabytes of headroom does that leave under a 4 GiB cap?',
      'Right, and one more doc question: what does the shared chat_common contract actually normalize across runtimes?',
    ],
  },
  {
    name: 'E7: broad-to-narrow — opener that narrows to one citable detail',
    turns: [
      'Give me the high-level idea of how the ADK defends against prompt injection through retrieved data and tool results.',
      'Zoom into the mechanism specifically — how do the nonce-keyed XML tags stop an attacker from escaping the content boundary?',
      'And precisely: why do images and audio each need two separate trust dimensions instead of one?',
      'Final detail: how does it defend against an injection that lands in memory or retrieval and only detonates months later?',
      "And how do I stop someone spoofing another participant's identity while I am at it?",
    ],
  },
]
