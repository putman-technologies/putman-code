import type { ComponentProps } from "react";
import { cn } from "../lib/utils";

export function PutmanCodeMark({ className, ...props }: ComponentProps<"img">) {
  return (
    <img
      {...props}
      alt=""
      src="/putman-code.png"
      className={cn("rounded-sm object-contain", className)}
    />
  );
}
