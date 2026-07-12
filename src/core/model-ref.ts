/** A provider-neutral model reference resolved by a ModelRegistry. */
export type ModelRef =
  | string
  | {
      readonly provider: string;
      readonly model: string;
    };
