import Image from "next/image";
import { Plus } from "lucide-react";
import { SHARE_SLOT_COUNT } from "@/lib/share/config";
import { ShareGame } from "@/lib/share/types";
import { SubjectKind } from "@/lib/subject-kind";
import { cn } from "@/lib/utils";

interface ReadonlyNineGridBoardProps {
  games: Array<ShareGame | null>;
  subjectLabel: string;
  kind?: SubjectKind;
}

function displayTitle(game: ShareGame) {
  return game.localizedName?.trim() || game.name;
}

function shouldTopCropCover(kind?: SubjectKind) {
  return kind === "character" || kind === "person";
}

export function ReadonlyNineGridBoard({ games, subjectLabel, kind }: ReadonlyNineGridBoardProps) {
  const useExpandedGrid = SHARE_SLOT_COUNT > 12;
  return (
    <div className={cn("grid w-full gap-2 sm:gap-3", useExpandedGrid ? "grid-cols-3 sm:grid-cols-4" : "grid-cols-3")}>
      {games.map((game, index) => {
        const id = game ? `subject-${game.id}-${index}` : `empty-${index}`;
        return (
          <div key={id} className="relative">
            <div className="relative flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
              {game?.cover ? (
                <Image
                  src={game.cover}
                  alt={displayTitle(game)}
                  fill
                  unoptimized
                  className={cn(
                    "absolute inset-0 object-cover select-none [-webkit-touch-callout:none]",
                    shouldTopCropCover(kind) && "object-top"
                  )}
                  sizes="(max-width: 640px) 30vw, (max-width: 1024px) 22vw, 180px"
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs font-medium text-muted-foreground">
                  <Plus className="h-4 w-4" />
                  <span>选择{subjectLabel}</span>
                </div>
              )}
              <div className="absolute left-1.5 top-1 text-[10px] font-semibold text-muted-foreground/70">
                {index + 1}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
