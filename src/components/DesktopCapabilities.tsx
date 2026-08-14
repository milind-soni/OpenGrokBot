import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { initialDesktopCapabilities, loadDesktopCapabilities } from "@/lib/desktop";

type DesktopState = {
  capabilities: DesktopCapabilities;
  ready: boolean;
};

const DesktopContext = createContext<DesktopState>({
  capabilities: initialDesktopCapabilities(),
  ready: !window.ogb,
});

export function DesktopCapabilitiesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DesktopState>(() => ({
    capabilities: initialDesktopCapabilities(),
    ready: !window.ogb,
  }));

  useEffect(() => {
    let alive = true;
    void loadDesktopCapabilities().then((capabilities) => {
      if (alive) setState({ capabilities, ready: true });
    });
    return () => {
      alive = false;
    };
  }, []);

  return <DesktopContext.Provider value={state}>{children}</DesktopContext.Provider>;
}

export function useDesktopCapabilities(): DesktopState {
  return useContext(DesktopContext);
}
