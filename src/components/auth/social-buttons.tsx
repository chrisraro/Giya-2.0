import { Button } from "@/components/ui/button";

export interface SocialButtonsProps {
  onGoogle: () => void;
  onFacebook: () => void;
}

export function SocialButtons({ onGoogle, onFacebook }: SocialButtonsProps) {
  return (
    <div className="flex flex-col gap-3">
      <Button type="button" variant="outlined" size="touch" className="w-full" onClick={onGoogle}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand mark, not an optimized content image */}
        <img src="/brand/google.svg" alt="" aria-hidden className="size-5" />
        Continue with Google
      </Button>
      <Button type="button" variant="outlined" size="touch" className="w-full" onClick={onFacebook}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand mark, not an optimized content image */}
        <img src="/brand/facebook.svg" alt="" aria-hidden className="size-5" />
        Continue with Facebook
      </Button>
    </div>
  );
}
