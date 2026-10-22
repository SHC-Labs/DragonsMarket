// Observed market history shared by the featured and detail Visx charts.
export interface Pt {
  at: number; // milliseconds
  p: number; // Yes probability, 0 to 100
}
