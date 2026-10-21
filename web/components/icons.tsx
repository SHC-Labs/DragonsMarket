import type { Icon, IconProps } from "iconsax-react";
import * as Iconsax from "iconsax-react";

// Explicit defaults support React 19, which no longer applies function defaultProps.
function icon(Component: Icon): Icon {
  return function AppIcon({ size = 20, color = "currentColor", variant = "Linear", ...props }: IconProps) {
    return <Component aria-hidden="true" {...props} size={size} color={color} variant={variant} />;
  };
}

export const ArrowUpDown = icon(Iconsax.ArrowSwapVertical);
export const LayoutGrid = icon(Iconsax.Category);
export const Search = icon(Iconsax.SearchNormal1);
export const X = icon(Iconsax.CloseCircle);
export const ArrowLeft = icon(Iconsax.ArrowLeft);
export const ArrowRight = icon(Iconsax.ArrowRight);
export const ArrowUpRight = icon(Iconsax.ExportSquare);
export const Pause = icon(Iconsax.Pause);
export const Play = icon(Iconsax.Play);
export const Moon = icon(Iconsax.Moon);
export const Sun = icon(Iconsax.Sun1);
export const Star = icon(Iconsax.Star1);
export const Share2 = icon(Iconsax.Share);
export const Bitcoin = icon(Iconsax.Bitcoin);
export const Bot = icon(Iconsax.Cpu);
export const CloudSun = icon(Iconsax.CloudSunny);
export const Cpu = icon(Iconsax.Cpu);
export const Film = icon(Iconsax.VideoPlay);
export const Clapperboard = icon(Iconsax.VideoPlay);
export const Flame = icon(Iconsax.Flash);
export const Globe = icon(Iconsax.Global);
export const Globe2 = icon(Iconsax.Global);
export const House = icon(Iconsax.Home2);
export const Landmark = icon(Iconsax.Bank);
export const Rocket = icon(Iconsax.Flash);
export const TrendingUp = icon(Iconsax.TrendUp);
export const Trophy = icon(Iconsax.Cup);
export const Vote = icon(Iconsax.People);
export const Gamepad2 = icon(Iconsax.Game);
export const ArrowDown = icon(Iconsax.ArrowDown);
export const Lock = icon(Iconsax.Lock1);
export const Clock = icon(Iconsax.Clock);
export const TickCircle = icon(Iconsax.TickCircle);
export const Judge = icon(Iconsax.Judge);
export const ShieldTick = icon(Iconsax.ShieldTick);
export const Wallet = icon(Iconsax.EmptyWallet);
export const Chart = icon(Iconsax.Chart);
export const Award = icon(Iconsax.Award);
export const Coin = icon(Iconsax.Coin);
export const People = icon(Iconsax.Profile2User);
export const Document = icon(Iconsax.DocumentText);
export const Timer = icon(Iconsax.Timer1);
export const StatusUp = icon(Iconsax.StatusUp);
export const Add = icon(Iconsax.Add);
export type { Icon as AppIcon } from "iconsax-react";
