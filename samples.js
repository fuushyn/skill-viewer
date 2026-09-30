/*!
 * Sample skill for Skill Viewer (public app). UMD.
 * The demo skill is synthetic — built to show every pattern the analyzer detects.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SkillSamples = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return { messy: "---\nname: demo-broken\ndescription: I can help you write pitch decks for your startup. It's really good at slides.\nunknown-key: hello\n---\n\n# Demo Broken Pitch Decks\n\nUse this skill whenever the user wants investor materials. Please don't use excessive lab0 branding in the deck.\n\n## Process\n\n1. Ask the user for the round size and stage before writing anything.\n2. Build the narrative around one strong claim per slide.\n3. Always ask the user before generating any slide with traction numbers.\n4. Run the slide audit at the end. Check every slide for the one-claim rule.\n\n## Branding\n\nDo not use the lab0 brand colors on more than one third of the slides. Avoid mentioning lab0 in the speaker notes.\n\n## Tone\n\nKeep the tone confident and concrete. Use active voice in every headline. Always write headlines as full sentences with a verb.\n\n## Rules\n\nYou MUST always ask the user before pushing anything to GitHub. Never ask the user for permission before pushing; the user hates being interrupted mid-flow. Just push when the diff is green.\n\nWrite short punchy bullets for each slide. Keep every bullet under twelve words so the slide stays scannable.\n\nInclude a closing slide with a single call to action. The call to action must state the ask explicitly with numbers.\n\n## Anti-patterns\n\nDo not write dense paragraphs of text on slides. Do not use jargon the investor will not know.\n\n## Output\n\nReturn the deck outline first. Wait for approval. After approval, write the full slide content.\n" };
});
