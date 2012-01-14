"
" Charles Color Scheme
" ===================
"
" Author:  Charles 
" Version:  0.1
"
set background=dark

hi clear
if exists("syntax_on")
    syntax reset
endif

let colors_name = "charles"

" Default Colors
hi Normal       guifg=#ffffff   guibg=#000000
hi NonText      guifg=#444444   guibg=#000000
hi Cursor       guibg=#aaaaaa
hi lCursor      guibg=#aaaaaa

" Search
hi Search       guifg=#800000   guibg=#ffae00
hi IncSearch    guifg=#800000   guibg=#ffae00

" Window Elements
hi StatusLine   guifg=#ffffff   guibg=#8090a0   gui=bold
hi StatusLineNC guifg=#506070   guibg=#a0b0c0
hi VertSplit    guifg=#a0b0c0   guibg=#a0b0c0
hi Folded       guifg=#111111   guibg=#8090a0
hi IncSearch    guifg=#708090   guibg=#f0e68c
hi Pmenu        guifg=#ffffff   guibg=#cb2f27
hi SignColumn   guibg=#111111
hi CursorLine   guibg=#181818
hi LineNr       guifg=#aaaaaa   guibg=#000000   gui=bold

" Specials
hi Todo         guifg=#e50808   guibg=#520000   gui=bold
hi Title        guifg=#ffffff                   gui=bold
hi Special      guifg=#ffff55

" Syntax Elements
hi String       guifg=#0086d2
hi Constant     guifg=#0086d2
hi Number       guifg=#0086f7                   gui=bold
hi Statement    guifg=#0099ff                   gui=bold
hi Function     guifg=#ffff99                   gui=bold
hi PreProc      guifg=#ff3333                   gui=bold
hi Comment      guifg=#55ff55   guibg=#000000   gui=italic
hi Type         guifg=#cdcaa9                   gui=bold
hi Error        guifg=#ffffff   guibg=#ab0000
hi Identifier   guifg=#fa8072                   gui=bold
hi Label        guifg=#ff0000

" Python Highlighting for python.vim
hi pythonCoding guifg=#ff0086
hi pythonRun    guifg=#ff0086
hi pythonBuiltinObj     guifg=#2b6ba2           gui=bold
hi pythonBuiltinFunc    guifg=#2b6ba2           gui=bold
hi pythonException      guifg=#ee0000           gui=bold
hi pythonExClass        guifg=#66cd66           gui=bold
hi pythonSpaceError     guibg=#270000
hi pythonDocTest    guifg=#2f5f49
hi pythonDocTest2   guifg=#3b916a
hi pythonFunction   guifg=#ee0000               gui=bold
hi pythonClass      guifg=#ff0086               gui=bold

" JavaScript Highlighting
hi javaScript                   guifg=#ffffff
hi javaScriptRegexpString       guifg=#aa6600
hi javaScriptDocComment         guifg=#aaaaaa
hi javaScriptCssStyles          guifg=#dd7700
hi javaScriptDomElemFuncs       guifg=#66cd66
hi javaScriptHtmlElemFuncs      guifg=#dd7700
hi javaScriptLabel              guifg=#00bdec   gui=italic
hi javaScriptPrototype          guifg=#00bdec
hi javaScriptConditional        guifg=#ff0007   gui=bold
hi javaScriptRepeat             guifg=#ff0007   gui=bold
hi javaScriptFunction           guifg=#ff0086   gui=bold

" CSS Highlighting
hi cssIdentifier            guifg=#66cd66       gui=bold
hi cssBraces                guifg=#00bdec       gui=bold

" XML Highlighting
"hi xmlTag           guifg=#ff0000                  
"hi xmlTagName       guifg=#666666                   
"hi xmlEndTag        guifg=#000000                  
"hi xmlEndTagName    guifg=#0000ff                   
hi xmlNamespace     guifg=#00bdec                   gui=underline
hi xmlAttribPunct   guifg=#cccaa9                   gui=bold
hi xmlEqual         guifg=#cccaa9                   gui=bold
hi xmlCdata         guifg=#bf0945                   gui=bold
hi xmlCdataCdata	guifg=#ac1446   guibg=#23010c   gui=none
hi xmlCdataStart	guifg=#bf0945                   gui=bold
hi xmlCdataEnd		guifg=#bf0945                   gui=bold

" HTML Highlighting
hi htmlTag          guifg=#00bdec               gui=bold
hi htmlEndTag       guifg=#00bdec               gui=bold
hi htmlSpecialTagName   guifg=#66cd66
hi htmlTagName      guifg=#66cd66
hi htmlTagN         guifg=#66cd66
hi htmlEvent        guifg=#ffffff

hi DiffAdd term=reverse cterm=bold ctermbg=green ctermfg=white 
hi DiffChange term=reverse cterm=bold ctermbg=cyan ctermfg=black 
hi DiffText term=reverse cterm=bold ctermbg=gray ctermfg=black 
hi DiffDelete term=reverse cterm=bold ctermbg=red ctermfg=black 
