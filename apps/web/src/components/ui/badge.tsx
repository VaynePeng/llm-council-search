import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-sm",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        /** 浅黄（过期提示等） */
        warning:
          "border border-status-warning-border bg-status-warning text-status-warning-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
        /** 浅红（错误文案） */
        destructive:
          "border border-status-error-border bg-status-error text-status-error-foreground shadow-sm",
        /** 浅绿（成功态） */
        success:
          "border border-status-success-border bg-status-success text-status-success-foreground shadow-sm",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
