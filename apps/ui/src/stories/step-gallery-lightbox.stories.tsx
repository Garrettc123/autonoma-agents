import type { Meta, StoryObj } from "@storybook/react-vite";
import { NavigableLightbox, type NavigableStep } from "components/screenshot-lightbox";
import { http } from "msw";
import { useState } from "react";

/** A frame that renders instantly (a data URL, never a network request) so the first step has a real image box -
 * the spinner in the loading story then sizes to it while the next, stalled frame decodes. */
const LOADED_FRAME = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='820' viewBox='0 0 1200 820'>
    <rect width='1200' height='820' fill='#f5f6f8'/>
    <rect width='1200' height='48' fill='#e6e8ec'/>
    <rect x='360' y='150' width='480' height='520' rx='12' fill='#ffffff' stroke='#e2e5ea'/>
    <text x='400' y='214' font-family='sans-serif' font-size='24' font-weight='600' fill='#1f2430'>Checkout</text>
    <rect x='400' y='274' width='400' height='40' rx='8' fill='#f0f2f5' stroke='#d7dbe2'/>
  </svg>`,
)}`;

// A frame the story's MSW handler holds open forever, so the gallery stays in its between-frames loading state.
const STALLED_FRAME = "https://frames.stall.local/step-2.png";

/** Owns the gallery's active index so `--click`-ing the Next arrow pages from the loaded frame to the stalled one. */
function GalleryLoadingDemo() {
  const [activeIndex, setActiveIndex] = useState<number | undefined>(0);
  const steps: NavigableStep[] = [
    { src: LOADED_FRAME, alt: "Step 1", points: [], stepNumber: 1, description: "Open the checkout page" },
    { src: STALLED_FRAME, alt: "Step 2", points: [], stepNumber: 2, description: "Fill in the shipping address" },
  ];
  return (
    <NavigableLightbox
      steps={steps}
      activeIndex={activeIndex}
      onClose={() => setActiveIndex(undefined)}
      onNavigate={setActiveIndex}
    />
  );
}

const meta = {
  title: "Components/StepGalleryLightbox",
  component: GalleryLoadingDemo,
  parameters: {
    layout: "fullscreen",
    // Never resolve the next frame's request, so the loading state holds still to be photographed.
    msw: { handlers: [http.get(`${STALLED_FRAME.replace("step-2.png", "")}*`, () => new Promise<Response>(() => {}))] },
  },
} satisfies Meta<typeof GalleryLoadingDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The frame gallery paging from a loaded step to one whose image has not decoded yet: the previous frame is blanked
 * behind a spinner rather than shown as if it were the new step. Shoot by clicking Next onto the stalled frame:
 *   storybook:shoot --story components-stepgallerylightbox--loading \
 *     --click 'button[aria-label="Next step"]' --wait-until domcontentloaded --settle-ms 1500
 */
export const Loading: Story = {};
