import type { ComponentType } from "react";
import { NavLink } from "react-router";

import { routes } from "../routes";
import { CardioIcon, HistoryIcon, HomeIcon, PadIcon, ResistanceIcon } from "./icons";

interface NavItem {
  to: string;
  label: string;
  Icon: ComponentType;
}

const navItems: readonly NavItem[] = [
  { to: routes.home, label: "Home", Icon: HomeIcon },
  { to: routes.pad, label: "PAD", Icon: PadIcon },
  { to: routes.resistance, label: "Resistance", Icon: ResistanceIcon },
  { to: routes.cardio, label: "Cardio", Icon: CardioIcon },
  { to: routes.history, label: "History", Icon: HistoryIcon },
];

export function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="Primary">
      <ul className="bottom-nav__list">
        {navItems.map(({ to, label, Icon }) => (
          <li key={to}>
            <NavLink to={to} end={to === routes.home} className="bottom-nav__link">
              <Icon />
              <span>{label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
