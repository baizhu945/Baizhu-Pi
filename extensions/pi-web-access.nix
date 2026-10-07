{ pkgs, lib, ... }:

let
  piPackageDir = "${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo";

  # Only the six remaining runtime libraries and their exact dependency tree.
  # MCP clients are vendored locally; Node 24 provides Promise.try.
  runtimeDependencies = {
    "node_modules/@mixmark-io/domino" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@mixmark-io/domino/-/domino-2.2.0.tgz";
      hash = "sha512-Y28PR25bHXUg88kCV7nivXrP2Nj2RueZ3/l/jdx6J9f8J4nsEGcgX0Qe6lt7Pa+J79+kPiJU3LguR6O/6zrLOw==";
    };
    "node_modules/@mozilla/readability" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@mozilla/readability/-/readability-0.6.0.tgz";
      hash = "sha512-juG5VWh4qAivzTAeMzvY9xs9HY5rAcr2E4I7tiSSCokRFi7XIZCAu92ZkSTsIj1OPceCifL3cpfteP3pDT9/QQ==";
    };
    "node_modules/@xmldom/xmldom" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@xmldom/xmldom/-/xmldom-0.9.12.tgz";
      hash = "sha512-5AXjrcMClTryPe9LgZrygpB1lj7s0S9E0+W+AHaVKAVyHanafK86iPSvG5xHVSp/jC+VH1UXu0TAEmY279xH7A==";
    };
    "node_modules/boolbase" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/boolbase/-/boolbase-1.0.0.tgz";
      hash = "sha512-JZOSA7Mo9sNGB8+UjSgzdLtokWAky1zbztM3WRLCbZ70/3cTANmQmOdR7y2g+J0e2WXywy1yS468tY+IruqEww==";
    };
    "node_modules/commander" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/commander/-/commander-12.1.0.tgz";
      hash = "sha512-Vw8qHK3bZM9y/P10u3Vib8o/DdkvA2OtPtZvD871QKjy74Wj1WSKFILMPRPSdUSx5RFK1arlJzEtA4PkFgnbuA==";
    };
    "node_modules/css-select" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/css-select/-/css-select-5.2.2.tgz";
      hash = "sha512-TizTzUddG/xYLA3NXodFM0fSbNizXjOKhqiQQwvhlspadZokn1KDy0NZFS0wuEubIYAV5/c1/lAr0TaaFXEXzw==";
    };
    "node_modules/css-what" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/css-what/-/css-what-6.2.2.tgz";
      hash = "sha512-u/O3vwbptzhMs3L1fQE82ZSLHQQfto5gyZzwteVIEyeaY5Fc7R4dapF/BvRoSYFeqfBk4m0V1Vafq5Pjv25wvA==";
    };
    "node_modules/cssom" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/cssom/-/cssom-0.5.0.tgz";
      hash = "sha512-iKuQcq+NdHqlAcwUY0o/HL69XQrUaQdMjmStJ8JFmUaiiQErlhrmuigkg/CU4E2J0IyUKUrMAgl36TvN67MqTw==";
    };
    "node_modules/defuddle" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/defuddle/-/defuddle-0.19.3.tgz";
      hash = "sha512-5ZbOQ/B+iiRRqSQWwmCx/zEuqZOA/5q7gxyE2/4O2Bxq7nUC0PgKw9EdyxqWbFF1nrrrYemSeR25jg4TmA2fsA==";
    };
    "node_modules/defuddle/node_modules/boolbase" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/boolbase/-/boolbase-2.0.0.tgz";
      hash = "sha512-DkVaaQHymRhpYEYo9x1oo7Q7B0Y6KJUsjm3c9eTyFDby4MHLBTwZ6ZDWBel5zrYxj1WsZgC5oLpiz+93MluXeA==";
    };
    "node_modules/defuddle/node_modules/css-select" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/css-select/-/css-select-7.0.0.tgz";
      hash = "sha512-snmjEVXy+1LnwXdxhYvTMj1d9tOh4HxkA1YmoayVBeeyR2C14Pum7fcxJIm4SswYspVy866eYNwlH6xC3/VH5g==";
    };
    "node_modules/defuddle/node_modules/css-select/node_modules/domelementtype" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/domelementtype/-/domelementtype-3.0.0.tgz";
      hash = "sha512-umCQid3jKbDmVjx8jGaW7uUykm4DEUeyV21hPxNMo2nV955DhUThwqyOIDtreepP31hl84X7G5U9ZfsWvIB3Pg==";
    };
    "node_modules/defuddle/node_modules/css-select/node_modules/domhandler" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/domhandler/-/domhandler-6.0.1.tgz";
      hash = "sha512-gYzvtM72ZtxQO0T048kd6HWSbbGCNOUwcnfQ01cqIJ4X2IYKFFHZ5mKvrQETcFXxsRObZulDaKmy//R7TPtsBg==";
    };
    "node_modules/defuddle/node_modules/css-select/node_modules/domutils" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/domutils/-/domutils-4.0.2.tgz";
      hash = "sha512-qI4JLRKnSzqFqr7hAlS5xQDusBCjKSEG4t4+7aNrIQMHBcsC2TGEhuyABJdYkgSewL57PNLYEiibY2iPKhKpaA==";
    };
    "node_modules/defuddle/node_modules/css-what" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/css-what/-/css-what-8.0.0.tgz";
      hash = "sha512-DH0Bqq3DNp5tdOReuNyAA+Ev4Y2GS5FMbZpeTLP6C4CDi0h5nL0BmUPChXw3o/qbHLDWHl49sbNqQVY7bMSDdw==";
    };
    "node_modules/defuddle/node_modules/dom-serializer" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/dom-serializer/-/dom-serializer-3.1.1.tgz";
      hash = "sha512-4MEa38/QexBob6gFNwu+EGdWvhJ1OKuNwdYY3Y3NyeWDQfnGeDYQUDfIRzWu5B5gsv03so2Uxd28YC6zrsx3Lw==";
    };
    "node_modules/defuddle/node_modules/dom-serializer/node_modules/domelementtype" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/domelementtype/-/domelementtype-3.0.0.tgz";
      hash = "sha512-umCQid3jKbDmVjx8jGaW7uUykm4DEUeyV21hPxNMo2nV955DhUThwqyOIDtreepP31hl84X7G5U9ZfsWvIB3Pg==";
    };
    "node_modules/defuddle/node_modules/dom-serializer/node_modules/domhandler" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/domhandler/-/domhandler-6.0.1.tgz";
      hash = "sha512-gYzvtM72ZtxQO0T048kd6HWSbbGCNOUwcnfQ01cqIJ4X2IYKFFHZ5mKvrQETcFXxsRObZulDaKmy//R7TPtsBg==";
    };
    "node_modules/defuddle/node_modules/dom-serializer/node_modules/entities" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/entities/-/entities-8.0.0.tgz";
      hash = "sha512-zwfzJecQ/Uej6tusMqwAqU/6KL2XaB2VZ2Jg54Je6ahNBGNH6Ek6g3jjNCF0fG9EWQKGZNddNjU5F1ZQn/sBnA==";
    };
    "node_modules/defuddle/node_modules/entities" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/entities/-/entities-7.0.1.tgz";
      hash = "sha512-TWrgLOFUQTH994YUyl1yT4uyavY5nNB5muff+RtWaqNVCAK408b5ZnnbNAUEWLTCpum9w6arT70i1XdQ4UeOPA==";
    };
    "node_modules/defuddle/node_modules/htmlparser2" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/htmlparser2/-/htmlparser2-10.1.0.tgz";
      hash = "sha512-VTZkM9GWRAtEpveh7MSF6SjjrpNVNNVJfFup7xTY3UpFtm67foy9HDVXneLtFVt4pMz5kZtgNcvCniNFb1hlEQ==";
    };
    "node_modules/defuddle/node_modules/linkedom" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/linkedom/-/linkedom-0.18.13.tgz";
      hash = "sha512-ES/o9qotMpzpN2MHs+Iq/JcVoOj8Fa5wiQYrTdFpvAnwXL0g66XHHUc9WUMk6nAlBtGsFQ24ne+SYnvnaQ2FSw==";
    };
    "node_modules/defuddle/node_modules/nth-check" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/nth-check/-/nth-check-3.0.1.tgz";
      hash = "sha512-GX0gsdbGVCgnRgbeGaubfjpBXyYRWOOCVeYh08bSQvDZqxz5ndXs1OTfAt/h36G1xvI94YIspsI0sVFqAV9+RQ==";
    };
    "node_modules/dom-serializer" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/dom-serializer/-/dom-serializer-2.0.0.tgz";
      hash = "sha512-wIkAryiqt/nV5EQKqQpo3SToSOV9J0DnbJqwK7Wv/Trc92zIAYZ4FlMu+JPFW1DfGFt81ZTCGgDEabffXeLyJg==";
    };
    "node_modules/domelementtype" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/domelementtype/-/domelementtype-2.3.0.tgz";
      hash = "sha512-OLETBj6w0OsagBwdXnPdN0cnMfF9opN69co+7ZrbfPGrdpPVNBUj02spi6B1N7wChLQiPn4CSH/zJvXw56gmHw==";
    };
    "node_modules/domhandler" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/domhandler/-/domhandler-5.0.3.tgz";
      hash = "sha512-cgwlv/1iFQiFnU96XXgROh8xTeetsnJiDsTc7TYCLFd9+/WNkIqPTxiM/8pSd8VIrhXGTf1Ny1q1hquVqDJB5w==";
    };
    "node_modules/domutils" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/domutils/-/domutils-3.2.2.tgz";
      hash = "sha512-6kZKyUajlDuqlHKVX1w7gyslj9MPIXzIFiz/rGu35uC1wMi+kMhQwGhl4lt9unC9Vb9INnY9Z3/ZA3+FhASLaw==";
    };
    "node_modules/entities" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/entities/-/entities-4.5.0.tgz";
      hash = "sha512-V0hjH4dGPh9Ao5p0MoRY6BVqtwCjhz6vI5LT8AJ55H+4g9/4vbHx1I54fS0XuclLhDHArPQCiMjDxjaL8fPxhw==";
    };
    "node_modules/html-escaper" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/html-escaper/-/html-escaper-3.0.3.tgz";
      hash = "sha512-RuMffC89BOWQoY0WKGpIhn5gX3iI54O6nRA0yC124NYVtzjmFWBIiFd8M0x+ZdX0P9R4lADg1mgP8C7PxGOWuQ==";
    };
    "node_modules/htmlparser2" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/htmlparser2/-/htmlparser2-9.1.0.tgz";
      hash = "sha512-5zfg6mHUoaer/97TxnGpxmbR7zJtPwIYFMZ/H5ucTlPZhKvtum05yiPK3Mgai3a0DyVxv7qYqoweaEd2nrYQzQ==";
    };
    "node_modules/linkedom" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/linkedom/-/linkedom-0.16.11.tgz";
      hash = "sha512-WgaTVbj7itjyXTsCvgerpneERXShcnNJF5VIV+/4SLtyRLN+HppPre/WDHRofAr2IpEuujSNgJbCBd5lMl6lRw==";
    };
    "node_modules/mathml-to-latex" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/mathml-to-latex/-/mathml-to-latex-1.8.0.tgz";
      hash = "sha512-gQ0uK3zqB8HwlfaXJkEL5rgaZNbKUiBMmBP/B/W+b+t6KcseLSuYb1b0BjLgS9ZiQa24ePkqTX8/6FaQuDL7wQ==";
    };
    "node_modules/nth-check" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/nth-check/-/nth-check-2.1.1.tgz";
      hash = "sha512-lqjrjmaOoAnWfMmBPL+XNnynZh2+swxiX3WUE0s4yEHI6m+AwrK2UZOimIRl3X/4QctVqS8AiZjFqyOGrMXb/w==";
    };
    "node_modules/p-limit" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/p-limit/-/p-limit-6.2.0.tgz";
      hash = "sha512-kuUqqHNUqoIWp/c467RI4X6mmyuojY5jGutNU0wVTmEOOfcuwLqyMVoAi9MKi2Ak+5i9+nhmrK4ufZE8069kHA==";
    };
    "node_modules/temml" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/temml/-/temml-0.13.5.tgz";
      hash = "sha512-aPkDDgunanpLNL0ql32HbolqLep+w8DRcVXRql7rWrMt/PhczdLgL4UBYYVU3BYjCNjkGq4EqwIicu/zWr1iOg==";
    };
    "node_modules/turndown" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/turndown/-/turndown-7.2.4.tgz";
      hash = "sha512-I8yFsfRzmzK0WV1pNNOA4A7y4RDfFxPRxb3t+e3ui14qSGOxGtiSP6GjeX+Y6CHb7HYaFj7ECUD7VE5kQMZWGQ==";
    };
    "node_modules/uhyphen" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/uhyphen/-/uhyphen-0.2.0.tgz";
      hash = "sha512-qz3o9CHXmJJPGBdqzab7qAYuW8kQGKNEuoHFYrBwV6hWIMcpAmxDLXojcHfFr9US1Pe6zUswEIJIbLI610fuqA==";
    };
    "node_modules/unpdf" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/unpdf/-/unpdf-1.8.0.tgz";
      hash = "sha512-jQlkckbe5nKxRHQdbvo9IKHlU6Cjq00UlxxB8lrCIxvS2o5IbAL1wM+4a1Yc3+BIohg9p5AsoaftwO+G4Aq/qQ==";
    };
    "node_modules/yocto-queue" = pkgs.fetchurl {
      url = "https://registry.npmjs.org/yocto-queue/-/yocto-queue-1.2.2.tgz";
      hash = "sha512-4LCcse/U2MHZ63HAJVE+v71o7yOdIe4cZ70Wpf8D/IyjDKYQLV5GD46B+hSTjJsvV5PztjvHoU580EftxjDZFQ==";
    };
  };

  piWebAccessLocal = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-web-access-local";
    version = "0.35.0-local.4";
    src = ./pi-web-access;
    nativeBuildInputs = [ pkgs.gnutar pkgs.nodejs pkgs.esbuild ];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      node scripts/build.mjs
      runHook postBuild
    '';
    dontFixup = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp -R ./. "$out/"
      ${lib.concatStringsSep "\n" (lib.mapAttrsToList (target: archive: ''
        mkdir -p "$out/${target}"
        tar -xzf ${archive} --strip-components=1 -C "$out/${target}"
      '') runtimeDependencies)}
      runHook postInstall
    '';
    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      node test/regression.mjs ${piPackageDir} "$out"
      runHook postInstallCheck
    '';
  };
in
{
  home.file.".pi/agent/extensions/pi-web-access" = {
    source = piWebAccessLocal;
    recursive = true;
  };
}
