# electron-builder picks this up from buildResources (electron/) when it compiles the NSIS installer.

!macro customUnInstall
  # An update reinstalls right after, so only a real uninstall takes the accounts and the cache with it.
  ${ifNot} ${isUpdated}
    RMDir /r "$PROFILE\.tokenlens"
  ${endIf}
!macroend
