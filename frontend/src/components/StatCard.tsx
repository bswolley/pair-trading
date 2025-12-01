import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: "up" | "down" | "neutral";
  icon?: React.ReactNode;
}

export function StatCard({ title, value, subtitle, trend, icon }: StatCardProps) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="pt-6 relative">
        {/* Gradient accent for trend */}
        {trend && (
          <div
            className={cn(
              "absolute top-0 left-0 right-0 h-1",
              trend === "up" && "bg-gradient-to-r from-emerald-500 to-emerald-400",
              trend === "down" && "bg-gradient-to-r from-red-500 to-red-400"
            )}
          />
        )}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p
              className={cn(
                "text-2xl font-bold mt-1",
                trend === "up" && "text-emerald-400",
                trend === "down" && "text-red-400"
              )}
            >
              {value}
            </p>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
            )}
          </div>
          {icon && (
            <div className={cn(
              "p-2 rounded-lg",
              trend === "up" && "text-emerald-400 bg-emerald-400/10",
              trend === "down" && "text-red-400 bg-red-400/10",
              !trend && "text-primary bg-primary/10"
            )}>
              {icon}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}


