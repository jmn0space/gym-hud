import { Page } from "../components/Page";
import { UnavailableState } from "../components/UnavailableState";

export function ResistancePage() {
  return (
    <Page heading="Resistance training">
      <UnavailableState title="Not available yet">
        Routines, exercises, and working weights aren't available in this version. Nothing on this
        screen is saved.
      </UnavailableState>
    </Page>
  );
}
