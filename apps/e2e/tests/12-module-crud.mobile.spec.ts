import { RECORD_SCREENS, recordJourney } from '../support/record-journey.ts';
import { DEFAULT_SCOPE, signInToProject, test } from '../support/fixtures.ts';

// The same journeys on a phone (Pixel 7): the actions must work, not only fit the width.
for (const target of RECORD_SCREENS) {
  test(`${target.module}: create, search, read, edit and delete on a phone`, async ({
    page,
    admin,
  }) => {
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await recordJourney(page, target, `m${Date.now()}`);
  });
}
