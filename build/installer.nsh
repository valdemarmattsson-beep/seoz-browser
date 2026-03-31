; ============================================================================
;  SEOZ Browser — NSIS custom installer hooks
;  Registers the app as a web browser in Windows so it appears in
;  Settings → Default Apps → Web browser
; ============================================================================

!macro customInstall
  ; --- ProgId: SEOZBrowserHTML ---
  ; This tells Windows how to open .html/.htm files and http/https URLs
  WriteRegStr HKLM "SOFTWARE\Classes\SEOZBrowserHTML" "" "SEOZ Browser HTML Document"
  WriteRegStr HKLM "SOFTWARE\Classes\SEOZBrowserHTML\DefaultIcon" "" "$INSTDIR\SEOZ Browser.exe,0"
  WriteRegStr HKLM "SOFTWARE\Classes\SEOZBrowserHTML\shell\open\command" "" '"$INSTDIR\SEOZ Browser.exe" "%1"'

  ; --- Capabilities ---
  ; Declares what this browser can handle (required for Default Apps UI)
  WriteRegStr HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser" "" "SEOZ Browser"
  WriteRegStr HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser\DefaultIcon" "" "$INSTDIR\SEOZ Browser.exe,0"
  WriteRegStr HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser\shell\open\command" "" '"$INSTDIR\SEOZ Browser.exe"'

  WriteRegStr HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser\Capabilities" "ApplicationName" "SEOZ Browser"
  WriteRegStr HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser\Capabilities" "ApplicationDescription" "SEOZ Browser – SEO-optimerad webbläsare"
  WriteRegStr HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser\Capabilities" "ApplicationIcon" "$INSTDIR\SEOZ Browser.exe,0"

  ; URL associations (http + https)
  WriteRegStr HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser\Capabilities\URLAssociations" "http" "SEOZBrowserHTML"
  WriteRegStr HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser\Capabilities\URLAssociations" "https" "SEOZBrowserHTML"

  ; File associations (html, htm, xhtml, shtml, svg)
  WriteRegStr HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser\Capabilities\FileAssociations" ".html" "SEOZBrowserHTML"
  WriteRegStr HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser\Capabilities\FileAssociations" ".htm" "SEOZBrowserHTML"
  WriteRegStr HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser\Capabilities\FileAssociations" ".xhtml" "SEOZBrowserHTML"
  WriteRegStr HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser\Capabilities\FileAssociations" ".shtml" "SEOZBrowserHTML"
  WriteRegStr HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser\Capabilities\FileAssociations" ".svg" "SEOZBrowserHTML"

  ; Start menu internet entry
  WriteRegStr HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser\InstallInfo" "IconsVisible" 1

  ; --- RegisteredApplications ---
  ; This is the KEY entry that makes Windows show the app in Default Apps
  WriteRegStr HKLM "SOFTWARE\RegisteredApplications" "SEOZ Browser" "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser\Capabilities"
!macroend


!macro customUnInstall
  ; Clean up all registry keys on uninstall
  DeleteRegKey HKLM "SOFTWARE\Classes\SEOZBrowserHTML"
  DeleteRegKey HKLM "SOFTWARE\Clients\StartMenuInternet\SEOZBrowser"
  DeleteRegValue HKLM "SOFTWARE\RegisteredApplications" "SEOZ Browser"
!macroend
