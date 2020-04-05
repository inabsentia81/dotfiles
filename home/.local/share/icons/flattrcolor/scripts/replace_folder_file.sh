#!/usr/bin/env bash
#	default color: 178984
oldglyph=#350225
newglyph=#3e0338

#	Front
#	default color: 36d7b7
oldfront=#790454
newfront=#850879

#	Back
#	default color: 1ba39c
oldback=#53033a
newback=#5b0553

sed -i "s/#524954/$oldglyph/g" $1
sed -i "s/#9b8aa0/$oldfront/g" $1
sed -i "s/#716475/$oldback/g" $1
sed -i "s/$oldglyph;/$newglyph;/g" $1
sed -i "s/$oldfront;/$newfront;/g" $1
sed -i "s/$oldback;/$newback;/g" $1
