import { Page } from "../components/Page";
import { UnavailableState } from "../components/UnavailableState";

export function PadPage() {
  return (
    <Page heading="PAD walking">
      <UnavailableState title="Not available yet">
        Walking bouts and rest intervals can't be recorded in this version. Nothing on this screen
        is saved.
      </UnavailableState>
    </Page>
  );
}
