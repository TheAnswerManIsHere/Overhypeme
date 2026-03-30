import React from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { motion, HTMLMotionProps } from "framer-motion";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface ButtonProps extends HTMLMotionProps<"button"> {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "lg" | "icon";
  isLoading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", isLoading, children, disabled, ...props }, ref) => {
    
    const variants = {
      primary: "bg-primary text-primary-foreground border-2 border-primary shadow-[0_0_15px_rgba(249,115,22,0.4)] hover:shadow-[0_0_25px_rgba(249,115,22,0.6)] hover:bg-orange-600 hover:border-orange-600",
      secondary: "bg-secondary text-secondary-foreground border-2 border-transparent hover:bg-secondary/80",
      outline: "bg-transparent text-foreground border-2 border-border hover:border-primary hover:text-primary",
      ghost: "bg-transparent text-muted-foreground border-2 border-transparent hover:text-foreground hover:bg-secondary/50",
      danger: "bg-destructive/10 text-destructive border-2 border-destructive/20 hover:bg-destructive hover:text-destructive-foreground",
    };

    const sizes = {
      sm: "h-9 px-4 text-sm font-medium",
      md: "h-11 px-6 text-base font-bold",
      lg: "h-14 px-8 text-lg font-bold uppercase tracking-wide",
      icon: "h-11 w-11 flex items-center justify-center p-0",
    };

    return (
      <motion.button
        ref={ref}
        whileHover={{ scale: disabled || isLoading ? 1 : 1.02 }}
        whileTap={{ scale: disabled || isLoading ? 1 : 0.98 }}
        disabled={disabled || isLoading}
        className={cn(
          "relative inline-flex items-center justify-center rounded-sm transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 disabled:cursor-not-allowed uppercase font-display tracking-wide",
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      >
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-inherit rounded-sm">
            <div className="h-5 w-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
          </div>
        ) : null}
        <span className={cn(isLoading && "opacity-0")}>{children}</span>
      </motion.button>
    );
  }
);
Button.displayName = "Button";
