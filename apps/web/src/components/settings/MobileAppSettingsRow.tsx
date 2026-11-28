import { LIGHTNING_BRAND } from "@t3tools/shared/brand";
import { T, useGT } from "gt-react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const mobileSetupUrl = `${LIGHTNING_BRAND.repositoryUrl}#mobile`;

export function MobileAppSettingsRow() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description={gt("Connect to your server from your phone or tablet.")}
      control={
        <Popover>
          <PopoverTrigger render={<Button size="sm" variant="outline" />}>
            <T>Mobile setup</T>
          </PopoverTrigger>
          <PopoverPopup align="end">
            <div className="flex flex-col items-center gap-3">
              <PopoverTitle>
                <T>Mobile setup</T>
              </PopoverTitle>
              <p className="text-xs text-muted-foreground">
                <T>Scan with your phone camera.</T>
              </p>
              <div className="rounded-lg bg-white p-1.5">
                <QRCodeSvg
                  value={mobileSetupUrl}
                  size={128}
                  level="M"
                  marginSize={1}
                  title={gt("Mobile setup")}
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                render={<a href={mobileSetupUrl} target="_blank" rel="noreferrer noopener" />}
              >
                <T context="verb, opens a page">Open</T>
              </Button>
            </div>
          </PopoverPopup>
        </Popover>
      }
    />
  );
}
