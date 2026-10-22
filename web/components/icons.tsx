import type { ComponentType, SVGProps } from "react";
import type { IconProps as PhosphorProps, IconWeight } from "@phosphor-icons/react";
import * as P from "@phosphor-icons/react/ssr";

// One icon set for the whole site: Phosphor. The variant names are the site's own and map onto Phosphor weights:
// Linear = outline, Bulk / TwoTone = duotone, Bold = filled.
export type IconVariant = "Linear" | "Bulk" | "TwoTone" | "Bold";
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "ref" | "color"> {
  size?: number | string;
  color?: string;
  variant?: IconVariant;
}
export type AppIcon = ComponentType<IconProps>;

const WEIGHT: Record<IconVariant, IconWeight> = { Linear: "regular", Bulk: "duotone", TwoTone: "duotone", Bold: "fill" };

// Explicit defaults support React 19, which no longer applies function defaultProps.
function icon(Component: ComponentType<PhosphorProps>): AppIcon {
  return function SiteIcon({ size = 20, color = "currentColor", variant = "Linear", ...props }: IconProps) {
    return <Component aria-hidden="true" {...(props as PhosphorProps)} size={size} color={color} weight={WEIGHT[variant]} />;
  };
}

// Interface
export const ArrowUpDown = icon(P.ArrowsDownUp);
export const LayoutGrid = icon(P.SquaresFour);
export const Search = icon(P.MagnifyingGlass);
export const X = icon(P.XCircle);
export const ArrowLeft = icon(P.ArrowLeft);
export const ArrowRight = icon(P.ArrowRight);
export const ArrowDown = icon(P.ArrowDown);
export const ArrowUpRight = icon(P.ArrowSquareOut);
export const Pause = icon(P.Pause);
export const Play = icon(P.Play);
export const Moon = icon(P.Moon);
export const Sun = icon(P.Sun);
export const Star = icon(P.Star);
export const Share2 = icon(P.ShareNetwork);
export const Lock = icon(P.Lock);
export const Clock = icon(P.Clock);
export const TickCircle = icon(P.CheckCircle);
export const Judge = icon(P.Gavel);
export const ShieldTick = icon(P.ShieldCheck);
export const Wallet = icon(P.Wallet);
export const Chart = icon(P.ChartLine);
export const Award = icon(P.Medal);
export const Coin = icon(P.Coin);
export const People = icon(P.Users);
export const Document = icon(P.FileText);
export const Timer = icon(P.Timer);
export const StatusUp = icon(P.ChartLineUp);
export const Add = icon(P.Plus);

// Categories and topics
export const Landmark = icon(P.Bank);
export const Vote = icon(P.Megaphone);
export const Trophy = icon(P.Trophy);
export const Bitcoin = icon(P.CurrencyBtc);
export const TrendingUp = icon(P.TrendUp);
export const Cpu = icon(P.Cpu);
export const Bot = icon(P.Brain);
export const Film = icon(P.FilmSlate);
export const Clapperboard = icon(P.FilmSlate);
export const Globe = icon(P.GlobeHemisphereWest);
export const Globe2 = icon(P.GlobeHemisphereWest);
export const CloudSun = icon(P.CloudSun);
export const House = icon(P.House);
export const Flame = icon(P.Drop);
export const Rocket = icon(P.Rocket);
export const Gamepad2 = icon(P.GameController);
export const Basketball = icon(P.Basketball);
export const Football = icon(P.Football);
export const Baseball = icon(P.Baseball);
export const SoccerBall = icon(P.SoccerBall);
export const Hockey = icon(P.Hockey);
export const TennisBall = icon(P.TennisBall);
export const RacingFlag = icon(P.FlagCheckered);
