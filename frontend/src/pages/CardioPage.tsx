import { Page } from "../components/Page";
import { UnavailableState } from "../components/UnavailableState";

export function CardioPage() {
  return (
    <Page heading="Cardio machines">
      <UnavailableState title="Not available yet">
        Cardio-machine sessions can't be recorded in this version. Nothing on this screen is saved.
      </UnavailableState>
    </Page>
  );
}
