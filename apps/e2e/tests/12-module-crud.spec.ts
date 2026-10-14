import { RECORD_SCREENS, recordJourney } from '../support/record-journey.ts';
import { DEFAULT_SCOPE, signInToProject, test } from '../support/fixtures.ts';

// Every record module, desktop: create, search, read, edit and delete through the UI.
for (const target of RECORD_SCREENS) {
  test(`${target.module}: create, search, read, edit and delete on desktop`, async ({
    page,
    admin,
  }) => {
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await recordJourney(page, target, `d${Date.now()}`);
  });
}
