"use client";

import { useEffect } from "react";
import { emitPublicConversionEvent, readPublicAttribution } from "@/lib/public/conversion";

export function PublicPageView({ event }: { event: "homepage_view" }) {
  useEffect(() => {
    emitPublicConversionEvent(
      event,
      readPublicAttribution(new URLSearchParams(window.location.search), window.location.pathname),
    );
  }, [event]);
  return null;
}
